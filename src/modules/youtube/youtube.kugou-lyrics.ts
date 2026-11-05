import axios from 'axios';
import { z } from 'zod';
import logger from '../../utils/logger';
import type { LyricsData, LyricsTrack, TimedLyric } from './youtube.lyrics';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_LYRICS_BYTES = 64 * 1024;
const MAX_LINES = 4000;
const MAX_PENDING = 16;
const candidateSchema = z.object({
  id: z.string().regex(/^\d{1,30}$/),
  accesskey: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
  song: z.string().min(1).max(300),
  singer: z.string().min(1).max(300),
  duration: z.number().int().min(1000).max(3_602_000),
});
const searchSchema = z.object({ status: z.literal(200).optional(), candidates: z.array(z.unknown()) });
const downloadSchema = z.object({ status: z.literal(200).optional(), content: z.string().max(90 * 1024) });
class InvalidResponse extends Error {}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function timestamp(timeMs: number): string {
  const minutes = Math.floor(timeMs / 60_000).toString().padStart(2, '0');
  const seconds = Math.floor(timeMs / 1000 % 60).toString().padStart(2, '0');
  return `[${minutes}:${seconds}.${(timeMs % 1000).toString().padStart(3, '0')}]`;
}

function lyricsData(encoded: string, duration: number): LyricsData | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new InvalidResponse();
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = bytes.toString('utf8');
  if (bytes.length > MAX_LYRICS_BYTES || bytes.toString('base64') !== encoded ||
      !Buffer.from(decoded, 'utf8').equals(bytes) || decoded.includes('\0')) throw new InvalidResponse();
  const lines = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split('\n');
  if (lines.length > MAX_LINES) throw new InvalidResponse();
  const synchronized: TimedLyric[] = [];
  let size = 0;
  let untimed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\s*\[offset:/i.test(line)) {
      const offset = line.trim().match(/^\[offset:([+-]?\d+)\]$/i);
      if (!offset || Number(offset[1]) !== 0) throw new InvalidResponse();
      continue;
    }
    const prefix = line.match(/^(?:\s*\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+/)?.[0];
    if (!prefix) {
      if (/^\s*\[[+-]?\d/.test(line)) throw new InvalidResponse();
      if (!/^\s*\[[A-Za-z][A-Za-z0-9_-]*:[^\]\r\n]*\]\s*$/.test(line)) untimed = true;
      continue;
    }
    const text = line.slice(prefix.length).replace(/<\d{1,3}:[0-5]\d(?:\.\d{1,3})?>/g, '').trim();
    for (const stamp of prefix.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      const timeMs = Number(stamp[1]) * 60_000 + Number(stamp[2]) * 1000 + Number((stamp[3] || '').padEnd(3, '0'));
      size += Buffer.byteLength(text, 'utf8');
      if (Number(stamp[2]) >= 60 || timeMs > (duration + 2) * 1000 ||
          size > MAX_LYRICS_BYTES || synchronized.length >= MAX_LINES) throw new InvalidResponse();
      synchronized.push({ timeMs, text });
    }
  }
  if (untimed && synchronized.length) throw new InvalidResponse();
  if (new Set(synchronized.filter(line => line.text).map(line => line.timeMs)).size < 2) return;
  synchronized.sort((a, b) => a.timeMs - b.timeMs);
  const text = synchronized.map(line => timestamp(line.timeMs) + line.text).join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_LYRICS_BYTES) throw new InvalidResponse();
  return { text, synchronized };
}

export class KugouLyricsClient {
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly cache = new Map<string, { expires: number; value?: LyricsData }>();

  async lookup(track: LyricsTrack, signal?: AbortSignal): Promise<LyricsData | undefined> {
    signal?.throwIfAborted();
    const artist = track.artist.replace(/\s*[-–—]\s*Topic$/i, '').trim();
    if (!normalized(track.title) || !normalized(artist) || track.title.length > 300 || artist.length > 300 ||
        (track.album?.length ?? 0) > 300 || !Number.isFinite(track.duration) || track.duration < 1 || track.duration > 3600) {
      this.log('invalid_input');
      return;
    }
    const key = JSON.stringify([normalized(track.title), normalized(artist), normalized(track.album || ''), track.duration]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      this.log('cache_hit', { found: !!cached.value });
      return cached.value;
    }
    if (this.queued >= MAX_PENDING) {
      this.log('queue_full');
      return;
    }
    this.queued++;
    const task = this.pending.then(() => this.request({ ...track, artist }, key, signal));
    this.pending = task.then(() => undefined, () => undefined);
    try { return await task; }
    finally { this.queued--; }
  }

  private log(reason: string, details: { found?: boolean } = {}): void {
    logger.info('KuGou timed lyrics', { reason, ...details });
  }

  private async json(endpoint: 'search' | 'download', parameters: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(`https://lyrics.kugou.com/${endpoint}`);
    url.search = new URLSearchParams(parameters).toString();
    const response = await axios.get<ArrayBuffer>(url.toString(), {
      responseType: 'arraybuffer', timeout: 5000, maxRedirects: 0, proxy: false, signal,
      maxContentLength: MAX_RESPONSE_BYTES, maxBodyLength: MAX_RESPONSE_BYTES,
      headers: { Accept: 'application/json', 'User-Agent': 'Hararest/1.0' },
    });
    signal?.throwIfAborted();
    const bytes = Buffer.from(response.data);
    const text = bytes.toString('utf8');
    if (bytes.length > MAX_RESPONSE_BYTES || !Buffer.from(text, 'utf8').equals(bytes)) throw new InvalidResponse();
    try { return JSON.parse(text); }
    catch { throw new InvalidResponse(); }
  }

  private async request(track: LyricsTrack, key: string, signal?: AbortSignal): Promise<LyricsData | undefined> {
    try {
      signal?.throwIfAborted();
      const cached = this.cache.get(key);
      if (cached && cached.expires > Date.now()) {
        this.log('cache_hit', { found: !!cached.value });
        return cached.value;
      }
      const search = searchSchema.safeParse(await this.json('search', {
        ver: '1', man: 'yes', client: 'pc', keyword: `${track.artist} - ${track.title}`,
        duration: String(Math.round(track.duration * 1000)),
      }, signal));
      if (!search.success) throw new InvalidResponse();
      let invalid = false;
      let downloads = 0;
      for (const raw of search.data.candidates.slice(0, 10)) {
        const parsed = candidateSchema.safeParse(raw);
        if (!parsed.success) { invalid = true; continue; }
        const candidate = parsed.data;
        if (normalized(candidate.song) !== normalized(track.title) || normalized(candidate.singer) !== normalized(track.artist) ||
            Math.abs(candidate.duration - track.duration * 1000) > 2000) continue;
        if (downloads >= 3) break;
        downloads++;
        const download = downloadSchema.safeParse(await this.json('download', {
          ver: '1', client: 'pc', id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', charset: 'utf8',
        }, signal));
        if (!download.success) throw new InvalidResponse();
        const value = lyricsData(download.data.content, track.duration);
        if (value) {
          this.remember(key, value);
          this.log('found');
          return value;
        }
      }
      if (invalid) throw new InvalidResponse();
      this.remember(key);
      this.log('empty');
    } catch (error) {
      if (signal?.aborted) {
        this.log('cancelled');
        signal.throwIfAborted();
      }
      this.log(error instanceof InvalidResponse ? 'invalid_response' : 'request_failed');
    }
  }

  private remember(key: string, value?: LyricsData): void {
    this.cache.delete(key);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { value, expires: Date.now() + (value ? 6 * 60 * 60_000 : 5 * 60_000) });
  }
}
