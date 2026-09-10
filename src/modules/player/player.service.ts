import { randomBytes } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { YoutubeService } from '../youtube/youtube.service';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

export const PLAYER_MAX_BYTES = 24 * 1024 * 1024;
export const PLAYER_CHUNK_BYTES = 64 * 1024;

export interface PlayerTrack {
  id: string;
  title: string;
  artist: string;
  duration: number;
  size: number;
  mimeType: string;
  expiresAt: string;
  wsUrl: string;
  playerUrl: string;
}

interface Session {
  track: PlayerTrack;
  audio: Buffer;
  expires: number;
}

export class PlayerService {
  private sessions = new Map<string, Session>();
  private pending = 0;
  private closed = false;

  constructor(
    private youtube: Pick<YoutubeService, 'search' | 'getInfo' | 'downloadAudio'>,
    private publicUrl: string,
    private limits = { ttlMs: 30 * 60_000, maxSessions: 8, maxBytes: PLAYER_MAX_BYTES, maxDuration: 600, maxPending: 2 },
  ) {}

  async prepare(input: unknown, signal?: AbortSignal, baseUrl?: unknown): Promise<PlayerTrack> {
    if (typeof input !== 'string' || !input.trim() || input.length > 500) {
      throw new AppError('Query must be a non-empty string of at most 500 characters.', 400);
    }
    let publicUrl: URL;
    try {
      const value = this.publicUrl || baseUrl;
      if (typeof value !== 'string') throw new Error('Missing base URL');
      publicUrl = new URL(value);
      if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password ||
        publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') throw new Error('Invalid origin');
    } catch { throw new AppError('Base URL player harus berupa origin HTTP(S) API yang valid.', 400); }
    this.sweep();
    if (this.closed || this.pending >= this.limits.maxPending || this.sessions.size + this.pending >= this.limits.maxSessions) {
      throw new AppError('Player sedang penuh. Coba lagi setelah beberapa saat.', 503);
    }
    this.pending++;
    let file: string | undefined;
    try {
      signal?.throwIfAborted();
      const query = input.trim();
      let url = query;
      if (!/^https?:\/\//i.test(query)) {
        const results = await this.youtube.search(query, 1, signal);
        const id = results[0]?.id;
        if (!id || !/^[\w-]{11}$/.test(id)) throw new AppError('Lagu tidak ditemukan.', 404);
        url = `https://www.youtube.com/watch?v=${id}`;
      }
      await assertPublicUrl(url, ['youtube.com', 'youtu.be']);
      signal?.throwIfAborted();
      const info = await this.youtube.getInfo(url, signal);
      if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > this.limits.maxDuration) {
        throw new AppError(`Player mendukung lagu hingga ${this.limits.maxDuration / 60} menit; live stream tidak didukung.`, 422);
      }
      file = await this.youtube.downloadAudio(url, { signal, maxBytes: this.limits.maxBytes });
      signal?.throwIfAborted();
      const size = (await stat(file)).size;
      if (size <= 0 || size > this.limits.maxBytes) throw new AppError('Audio kosong atau melebihi batas ukuran player.', 422);
      const audio = await readFile(file, { signal });
      if (audio.length <= 0 || audio.length > this.limits.maxBytes) throw new AppError('Ukuran audio tidak valid.', 422);
      signal?.throwIfAborted();
      if (this.closed) throw new AppError('Player sedang dimatikan.', 503);
      const id = randomBytes(24).toString('hex');
      const expires = Date.now() + this.limits.ttlMs;
      const wsUrl = new URL(`/ws/player/${id}`, publicUrl);
      wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const track: PlayerTrack = {
        id, title: info.title, artist: info.channel.name, duration: info.duration,
        size: audio.length, mimeType: 'audio/mpeg', expiresAt: new Date(expires).toISOString(),
        wsUrl: wsUrl.href, playerUrl: new URL(`/player/${id}`, publicUrl).href,
      };
      this.sessions.set(id, { track, audio, expires });
      return track;
    } catch (error) {
      if (signal?.aborted) throw new AppError('Penyiapan audio dibatalkan atau melewati batas waktu.', 408);
      throw error;
    } finally {
      this.pending--;
      if (file) await unlink(file).catch(() => logger.warn('Could not remove player download temporary file'));
    }
  }

  get(id: string): Session | undefined {
    this.sweep();
    return this.sessions.get(id);
  }

  sweep(): void {
    for (const [id, session] of this.sessions) {
      if (session.expires <= Date.now()) this.sessions.delete(id);
    }
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  close(): void {
    this.closed = true;
    this.sessions.clear();
  }
}
