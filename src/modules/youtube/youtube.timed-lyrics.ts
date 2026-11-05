import { ChildProcess, execFile } from 'child_process';
import path from 'node:path';
import { z } from 'zod';
import logger from '../../utils/logger';
import type { LyricsData } from './youtube.lyrics';

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_LYRICS_BYTES = 64 * 1024;
const MAX_PENDING = 16;
const responseSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  lines: z.array(z.object({
    timeMs: z.number().int().min(0),
    text: z.string().max(MAX_LYRICS_BYTES),
  })).max(4000),
});

function videoIdFromURL(value: string): string | undefined {
  try {
    const url = new URL(value);
    const id = url.searchParams.get('v');
    if (['http:', 'https:'].includes(url.protocol) && url.hostname === 'music.youtube.com' &&
      !url.username && !url.password && !url.port && url.pathname === '/watch' &&
      id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch { /* Invalid input is an optional-source miss. */ }
}

function timestamp(timeMs: number): string {
  const minutes = Math.floor(timeMs / 60_000).toString().padStart(2, '0');
  const seconds = Math.floor(timeMs / 1000 % 60).toString().padStart(2, '0');
  return `[${minutes}:${seconds}.${(timeMs % 1000).toString().padStart(3, '0')}]`;
}

// Only original timestamps from the exact requested video are accepted. A
// timed source never estimates line timings from the length of the audio.
export class YoutubeTimedLyrics {
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly cache = new Map<string, { expires: number; value?: LyricsData }>();

  async lookup(url: string, duration: number, signal?: AbortSignal): Promise<LyricsData | undefined> {
    signal?.throwIfAborted();
    const id = videoIdFromURL(url);
    if (!id || !Number.isFinite(duration) || duration < 1 || duration > 3600) {
      this.log('invalid_input');
      return;
    }
    const key = JSON.stringify([id, duration]);
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
    const task = this.pending.then(() => this.request(id, duration, key, signal));
    this.pending = task.then(() => undefined, () => undefined);
    try { return await task; }
    finally { this.queued--; }
  }

  private log(reason: string, details: Record<string, boolean> = {}): void {
    logger.info('YouTube Music timed lyrics', { reason, ...details });
  }

  private async request(id: string, duration: number, key: string, signal?: AbortSignal): Promise<LyricsData | undefined> {
    try {
      signal?.throwIfAborted();
      // A preceding queued lookup may have populated this exact recording.
      const cached = this.cache.get(key);
      if (cached && cached.expires > Date.now()) {
        this.log('cache_hit', { found: !!cached.value });
        return cached.value;
      }
      const output = await this.run(id, signal);
      signal?.throwIfAborted();
      if (Buffer.byteLength(output, 'utf8') > MAX_RESPONSE_BYTES) {
        this.log('invalid_response');
        return;
      }
      const parsed = responseSchema.safeParse(JSON.parse(output));
      if (!parsed.success || parsed.data.videoId !== id) {
        this.log('invalid_response');
        return;
      }
      const lines = parsed.data.lines;
      if (lines.length === 0) {
        this.remember(key);
        this.log('empty');
        return;
      }
      let size = 0;
      for (const line of lines) {
        size += Buffer.byteLength(line.text, 'utf8');
        if (line.text.includes('\0') || Buffer.from(line.text, 'utf8').toString('utf8') !== line.text ||
          line.timeMs > (duration + 2) * 1000 || size > MAX_LYRICS_BYTES) {
          this.log('invalid_response');
          return;
        }
      }
      const synchronized = lines.map(line => ({ timeMs: line.timeMs, text: line.text.replace(/\r\n?|\n/g, ' ').trim() }))
        .sort((a, b) => a.timeMs - b.timeMs);
      if (!synchronized.some(line => line.text)) {
        this.log('invalid_response');
        return;
      }
      const text = synchronized.map(line => `${timestamp(line.timeMs)}${line.text}`).join('\n');
      if (Buffer.byteLength(text, 'utf8') > MAX_LYRICS_BYTES) {
        this.log('invalid_response');
        return;
      }
      const value = { text, synchronized };
      this.remember(key, value);
      this.log('found');
      return value;
    } catch {
      if (signal?.aborted) {
        this.log('cancelled');
        signal.throwIfAborted();
      }
      // Optional-source failures must never replace existing usable lyrics.
      this.log('request_failed');
      return;
    }
  }

  private async run(videoId: string, signal?: AbortSignal): Promise<string> {
    let child: ChildProcess | undefined;
    const output = new Promise<string>((resolve, reject) => {
      child = execFile(process.env.PYTHON_BIN || 'python3', [
        path.resolve(__dirname, '../../../src/modules/youtube/ytmusic_lyrics.py'), videoId,
      ], { signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: MAX_RESPONSE_BYTES }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    try { return await output; }
    finally {
      // Abort can invoke execFile's callback before the child is reaped.
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => child!.once('close', () => resolve()));
      }
    }
  }

  private remember(key: string, value?: LyricsData): void {
    this.cache.delete(key);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { value, expires: Date.now() + (value ? 6 * 60 * 60_000 : 5 * 60_000) });
  }
}
