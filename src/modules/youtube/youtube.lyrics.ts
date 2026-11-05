import { ChildProcess, execFile } from 'child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readResponseText } from '../../utils/readResponse';
import logger from '../../utils/logger';
import { YoutubeTimedLyrics } from './youtube.timed-lyrics';
import { KugouLyricsClient } from './youtube.kugou-lyrics';

const MAX_LYRICS_BYTES = 64 * 1024;
const recordSchema = z.object({
  trackName: z.string().min(1).max(300),
  artistName: z.string().min(1).max(300),
  albumName: z.string().max(300),
  duration: z.number().finite().min(1).max(3600),
  instrumental: z.boolean(),
  plainLyrics: z.string().max(MAX_LYRICS_BYTES).nullable().optional(),
  syncedLyrics: z.string().max(MAX_LYRICS_BYTES).nullable().optional(),
});

export interface LyricsTrack {
  title: string;
  artist: string;
  album?: string;
  duration: number;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function isYoutubeMusicURL(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname === 'music.youtube.com';
  } catch { return false; }
}

export interface TimedLyric { timeMs: number; text: string }
export interface LyricsData { text: string; synchronized: TimedLyric[] }

function lyricsData(record: z.infer<typeof recordSchema>): LyricsData | undefined {
  const clean = (value: string) => value.replace(/\r\n?/g, '\n').split('\0').join('').trim();
  const lrc = clean(record.syncedLyrics || '');
  const synchronized: TimedLyric[] = [];
  let expandedBytes = 0;
  let invalid = Buffer.byteLength(lrc, 'utf8') > MAX_LYRICS_BYTES || /\[offset:\s*[+-]?[1-9]\d*\]/i.test(lrc);
  for (const line of lrc.split('\n')) {
    if (invalid) break;
    const prefix = line.match(/^(?:\s*\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+/)?.[0];
    if (!prefix) continue;
    const text = line.slice(prefix.length).trim().replace(/<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g, '');
    const textBytes = Buffer.byteLength(text, 'utf8');
    for (const stamp of prefix.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      const timeMs = Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + Number((stamp[3] || '').padEnd(3, '0'));
      expandedBytes += textBytes;
      if (Number(stamp[2]) >= 60 || timeMs > (record.duration + 2) * 1000 || expandedBytes > MAX_LYRICS_BYTES || synchronized.length >= 4000) { invalid = true; break; }
      synchronized.push({ timeMs, text });
    }
  }
  if (invalid || synchronized.length > 4000 || !synchronized.some(line => line.text)) synchronized.length = 0;
  synchronized.sort((a, b) => a.timeMs - b.timeMs);
  // Keep LRC in USLT for players that parse timestamps from the Lyrics field.
  // Also encode the same timing in standard SYLT for players that read ID3 timing.
  const text = synchronized.length ? lrc : clean(record.plainLyrics || lrc.split('\n')
    .filter(line => /^\s*\[\d+:\d+(?:\.\d+)?\]/.test(line))
    .map(line => line.replace(/^(?:\s*\[\d+:\d+(?:\.\d+)?\])+\s*/, '')).join('\n'));
  return text && Buffer.byteLength(text, 'utf8') <= MAX_LYRICS_BYTES ? { text, synchronized } : undefined;
}

export class LyricsClient {
  private pending: Promise<void> = Promise.resolve();
  private nextRequest = 0;
  private blockedUntil = 0;
  private readonly cache = new Map<string, { expires: number; value?: LyricsData }>();

  lookup(track: LyricsTrack, signal?: AbortSignal): Promise<LyricsData | undefined> {
    const task = this.pending.then(() => this.request(track, signal));
    this.pending = task.then(() => undefined, () => undefined);
    return task;
  }

  private log(reason: string, detail: Record<string, number | boolean> = {}): void {
    // Do not include track metadata, URLs, upstream bodies or exception messages.
    logger.info('YouTube Music lyrics lookup', { reason, ...detail });
  }

  private async request(track: LyricsTrack, signal?: AbortSignal): Promise<LyricsData | undefined> {
    if (signal?.aborted) {
      this.log('cancelled');
      signal.throwIfAborted();
    }
    const artist = track.artist.replace(/\s*[-–—]\s*Topic$/i, '').trim();
    if (!track.title.trim() || !artist || track.title.length > 300 || artist.length > 300 ||
        (track.album?.length ?? 0) > 300 || !Number.isFinite(track.duration) || track.duration < 1 || track.duration > 3600) {
      this.log('invalid_metadata');
      return;
    }
    const key = JSON.stringify([normalized(track.title), normalized(artist), normalized(track.album || ''), Math.round(track.duration)]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      this.log('cache_hit', { found: !!cached.value });
      return cached.value;
    }
    this.log('cache_miss');
    if (Date.now() < this.blockedUntil) {
      this.log('cooldown');
      return;
    }
    const url = new URL('https://lrclib.net/api/get');
    url.search = new URLSearchParams({
      track_name: track.title, artist_name: artist, duration: String(track.duration),
      ...(track.album ? { album_name: track.album } : {}),
    }).toString();

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const waitUntil = Math.max(this.nextRequest, this.blockedUntil);
        if (waitUntil > Date.now()) await delay(waitUntil - Date.now(), undefined, { signal });
        signal?.throwIfAborted();
        const response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': 'Hararest/1.0 (https://github.com/sanxlab/hararest)' },
          redirect: 'error',
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
        });
        if (response.status === 429 || response.status === 503) {
          const retry = response.headers.get('retry-after');
          const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) : NaN;
          const date = retry === null || Number.isFinite(seconds) ? NaN : Date.parse(retry);
          const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 30_000;
          const cooldown = Math.max(1000, requestedDelay);
          this.blockedUntil = Date.now() + cooldown + Math.floor(Math.random() * 100);
          const retrying = attempt === 1 && cooldown <= 2000;
          this.log('http_error', { httpStatus: response.status, attempt, retrying });
          await response.body?.cancel();
          if (retrying) continue;
          return;
        }
        if (!response.ok) {
          const retrying = attempt === 1 && [500, 502, 504].includes(response.status);
          this.log(response.status === 404 ? 'not_found' : 'http_error', { httpStatus: response.status, attempt, retrying });
          await response.body?.cancel();
          if (retrying) continue;
          if (response.status === 404) this.remember(key);
          return;
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
          this.log('wrong_content_type', { httpStatus: response.status, attempt });
          await response.body?.cancel();
          return;
        }
        const parsed = recordSchema.safeParse(JSON.parse(await readResponseText(response, 256 * 1024)));
        if (!parsed.success) {
          this.log('invalid_record', { attempt });
          return;
        }
        const record = parsed.data;
        const matches = {
          titleMatches: normalized(record.trackName) === normalized(track.title),
          artistMatches: normalized(record.artistName) === normalized(artist),
          durationMatches: Math.abs(record.duration - track.duration) <= 2,
          albumMatches: !track.album || normalized(record.albumName) === normalized(track.album),
        };
        if (!Object.values(matches).every(Boolean)) {
          this.log('metadata_mismatch', { attempt, ...matches });
          return;
        }
        const value = record.instrumental ? undefined : lyricsData(record);
        this.remember(key, value);
        this.log(record.instrumental ? 'instrumental' : value ? 'found' : 'no_lyrics', { attempt, synchronized: !!value?.synchronized.length });
        return value;
      } catch (error) {
        if (signal?.aborted) {
          this.log('cancelled', { attempt });
          signal.throwIfAborted();
        }
        const errorName = error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : '';
        const timeout = errorName === 'TimeoutError';
        const network = errorName === 'TypeError';
        const retrying = attempt === 1 && (timeout || network);
        const oversized = error !== null && typeof error === 'object' && 'statusCode' in error && error.statusCode === 502;
        this.log(timeout ? 'network_timeout' : network ? 'network_error' : oversized ? 'response_too_large' : errorName === 'SyntaxError' ? 'invalid_json' : 'request_failed', { attempt, retrying });
        if (!retrying) throw error;
      } finally { this.nextRequest = Date.now() + 300; }
    }
  }

  private remember(key: string, value?: LyricsData): void {
    this.cache.delete(key);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { value, expires: Date.now() + (value ? 6 * 60 * 60_000 : 5 * 60_000) });
  }
}

async function command(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  let child: ChildProcess | undefined;
  const output = new Promise<string>((resolve, reject) => {
    child = execFile(binary, args, { signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  try { return await output; }
  finally {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => child!.once('close', () => resolve()));
    }
  }
}

// Prepend USLT and optional SYLT frames, streaming all existing tags/audio untouched.
// Older FFmpeg builds can write a custom TXXX field instead of a real lyrics frame.
async function writeLyrics(file: string, output: string, lyrics: LyricsData, maxBytes: number, signal?: AbortSignal): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  const header = Buffer.alloc(10);
  let size: number;
  try {
    size = (await handle.stat()).size;
    await handle.read(header, 0, 10, 0);
  } finally { await handle.close(); }
  const hasTag = header.toString('ascii', 0, 3) === 'ID3';
  const version = hasTag ? header[3] : 3;
  // yt-dlp writes ordinary v2.3/v2.4 tags. Leave other/unsynchronised tags intact.
  if ((version !== 3 && version !== 4) || (hasTag && (header[5] !== 0 || header.subarray(6).some(byte => byte > 127)))) return false;
  const tagSize = hasTag ? header[6] * 0x200000 + header[7] * 0x4000 + header[8] * 0x80 + header[9] : 0;
  if (hasTag && tagSize + 10 > size) return false;
  const utf16 = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const descriptor = Buffer.from([0xff, 0xfe, 0, 0]);
  const frame = (id: string, body: Buffer): Buffer => {
    const frameHeader = Buffer.alloc(10);
    frameHeader.write(id, 0, 'ascii');
    if (version === 3) frameHeader.writeUInt32BE(body.length, 4);
    else for (let i = 0; i < 4; i++) frameHeader[4 + i] = (body.length >>> (21 - i * 7)) & 127;
    return Buffer.concat([frameHeader, body]);
  };
  const frames = [frame('USLT', Buffer.concat([Buffer.from([1]), Buffer.from('und'), descriptor, utf16(lyrics.text)]))];
  if (lyrics.synchronized.length) {
    const entries = lyrics.synchronized.map(line => {
      const timestamp = Buffer.alloc(4);
      timestamp.writeUInt32BE(line.timeMs);
      return Buffer.concat([utf16(line.text), Buffer.from([0, 0]), timestamp]);
    });
    // Timestamp format 2 = absolute milliseconds; content type 1 = lyrics.
    frames.push(frame('SYLT', Buffer.concat([Buffer.from([1]), Buffer.from('und'), Buffer.from([2, 1]), descriptor, ...entries])));
  }
  const added = Buffer.concat(frames);
  const updatedSize = tagSize + added.length;
  if (updatedSize > 0x0fffffff || size + added.length + (hasTag ? 0 : 10) > maxBytes) return false;
  if (!hasTag) { header.fill(0); header.write('ID3', 0, 'ascii'); header[3] = 3; }
  for (let i = 0; i < 4; i++) header[6 + i] = (updatedSize >>> (21 - i * 7)) & 127;
  signal?.throwIfAborted();
  await fs.writeFile(output, Buffer.concat([header, added]), { mode: 0o600 });
  await pipeline(createReadStream(file, { start: hasTag ? 10 : 0 }), createWriteStream(output, { flags: 'a' }), { signal });
  return true;
}

export class YoutubeMusicLyrics {
  constructor(
    private readonly client = new LyricsClient(),
    private readonly timedClient: Pick<YoutubeTimedLyrics, 'lookup'> = new YoutubeTimedLyrics(),
    private readonly kugouClient: Pick<KugouLyricsClient, 'lookup'> = new KugouLyricsClient(),
  ) {}

  async enrich(file: string, url: string, options: { signal?: AbortSignal; maxBytes: number }): Promise<void> {
    if (!isYoutubeMusicURL(url)) {
      logger.info('YouTube Music lyrics skipped', { reason: 'not_youtube_music' });
      return;
    }
    const output = `${file}.lyrics.mp3`;
    let stage = 'probe';
    try {
      options.signal?.throwIfAborted();
      logger.info('YouTube Music lyrics enrichment started');
      const probe = JSON.parse(await command('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration:format_tags', '-of', 'json', file,
      ], options.signal)) as { format?: { duration?: string; tags?: Record<string, string> } };
      const tags = probe.format?.tags;
      if (!tags?.title?.trim() || !tags.artist?.trim()) {
        logger.warn('YouTube Music lyrics not embedded', { stage, reason: 'missing_track_metadata' });
        return;
      }
      if (Object.entries(tags).some(([key, value]) => /^lyrics(?:-|$)/i.test(key) && value.trim())) {
        logger.info('YouTube Music lyrics skipped', { reason: 'already_embedded' });
        return;
      }
      stage = 'lookup';
      const duration = Number(probe.format?.duration);
      const track = { title: tags.title, artist: tags.artist, album: tags.album, duration };
      let lyrics: LyricsData | undefined;
      let source = 'lrclib';
      try {
        lyrics = await this.client.lookup(track, options.signal);
      } catch {
        options.signal?.throwIfAborted();
        logger.info('YouTube Music lyrics fallback needed', { reason: 'lrclib_failed' });
      }
      if (!lyrics?.synchronized.length) {
        stage = 'youtube_music_lookup';
        try {
          const timed = await this.timedClient.lookup(url, duration, options.signal);
          if (timed?.synchronized.length) {
            lyrics = timed;
            source = 'youtube_music';
          }
        } catch {
          options.signal?.throwIfAborted();
          logger.info('YouTube Music timed lyrics unavailable', { reason: 'fallback_failed' });
        }
      }
      if (!lyrics?.synchronized.length) {
        stage = 'kugou_lookup';
        try {
          const timed = await this.kugouClient.lookup(track, options.signal);
          if (timed?.synchronized.length) {
            lyrics = timed;
            source = 'kugou';
          }
        } catch {
          options.signal?.throwIfAborted();
          logger.info('YouTube Music timed lyrics unavailable', { reason: 'kugou_failed' });
        }
      }
      if (!lyrics) {
        logger.info('YouTube Music lyrics not embedded', { stage, reason: 'not_available' });
        return;
      }
      options.signal?.throwIfAborted();
      stage = 'embed';
      if (await writeLyrics(file, output, lyrics, options.maxBytes, options.signal)) {
        options.signal?.throwIfAborted();
        await fs.rename(output, file);
        logger.info('YouTube Music lyrics embedded', { source, synchronized: lyrics.synchronized.length > 0 });
      } else {
        logger.warn('YouTube Music lyrics not embedded', { stage, reason: 'unsupported_tag_or_size_limit' });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      // Lyrics are optional: keep the already downloaded, tagged audio on failure.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      logger.warn('YouTube Music lyrics unavailable; keeping audio without additional lyrics.', {
        stage,
        reason: code === 'ENOENT' ? 'binary_missing' : error instanceof SyntaxError ? 'invalid_response' : `${stage}_failed`,
      });
    } finally {
      await fs.rm(output, { force: true }).catch(() => undefined);
    }
  }
}

export const youtubeMusicLyrics = new YoutubeMusicLyrics();
