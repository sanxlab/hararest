import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

export type JobResult =
  | { kind: 'file'; path: string; size: number; mimeType: string }
  | { kind: 'player'; data: unknown; dispose: () => void };
export type JobState = 'queued' | 'processing' | 'ready' | 'failed';
type Work = (signal: AbortSignal) => Promise<JobResult>;
interface Job {
  id: string;
  key?: string;
  fingerprint: string;
  state: JobState;
  createdAt: number;
  expiresAt: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  work: Work;
  result?: JobResult;
  error?: string;
  readers: number;
  removed: boolean;
  working: boolean;
}

export const JOB_LIMITS = {
  concurrency: 2, maxJobs: 16, timeoutMs: 9 * 60_000, ttlMs: 30 * 60_000,
  maxFileBytes: 256 * 1024 * 1024, maxStoredBytes: 512 * 1024 * 1024,
};

// Single-process bounded queue. Client disconnects do not cancel accepted jobs.
// IDs are bearer tokens; do not expose input URLs, paths, or extractor stderr.
export class JobService {
  private jobs = new Map<string, Job>();
  private keys = new Map<string, string>();
  private running = new Set<Promise<void>>();
  private cleanups = new Set<Promise<void>>();
  private storedBytes = 0;
  private closed = false;
  private sweepTimer: NodeJS.Timeout;
  private storageReady: Promise<void>;

  constructor(private limits = JOB_LIMITS, private spoolDir?: string) {
    this.storageReady = this.prepareStorage();
    // Keep initialization rejection handled until a worker can report it.
    void this.storageReady.catch(() => logger.warn('Could not initialize job storage'));
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  submit(fingerprint: string, work: Work, key?: string) {
    this.sweep();
    if (this.closed) throw new AppError('Job service sedang dimatikan.', 503);
    if (key !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      throw new AppError('Idempotency-Key harus terdiri dari 16–128 huruf, angka, _ atau -.', 400);
    }
    const previous = key ? this.jobs.get(this.keys.get(key) ?? '') : undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError('Idempotency-Key sudah dipakai untuk permintaan berbeda.', 409);
      return this.snapshot(previous);
    }
    if (this.jobs.size >= this.limits.maxJobs) throw new AppError('Antrean job penuh. Coba lagi nanti.', 503);
    const now = Date.now();
    const job: Job = {
      id: randomBytes(24).toString('hex'), key, fingerprint, work, state: 'queued',
      createdAt: now, expiresAt: now + this.limits.timeoutMs, controller: new AbortController(),
      timer: setTimeout(() => this.timeout(job), this.limits.timeoutMs), readers: 0, removed: false, working: false,
    };
    job.timer.unref();
    this.jobs.set(job.id, job);
    if (key) this.keys.set(key, job.id);
    // Yield before invoking even synchronous work so POST can return immediately.
    setImmediate(() => this.pump());
    return this.snapshot(job);
  }

  get(id: string) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) throw new AppError('Job tidak ditemukan atau sudah kedaluwarsa. Buat permintaan baru.', 410);
    return this.snapshot(job);
  }

  acquireFile(id: string) {
    this.get(id);
    const job = this.jobs.get(id)!;
    if (job.state !== 'ready' || job.result?.kind !== 'file') throw new AppError('File job belum tersedia.', 409);
    job.readers++;
    let released = false;
    return { file: job.result, release: () => {
      if (released) return;
      released = true;
      job.readers--;
      if (job.removed && job.readers === 0) this.dispose(job);
    } };
  }

  sweep() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.expiresAt > now) continue;
      if (job.state === 'queued' || job.state === 'processing') this.timeout(job);
      else this.remove(job);
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const job of this.jobs.values()) {
      job.controller.abort();
      this.remove(job);
    }
    await Promise.allSettled([...this.running]);
    await Promise.allSettled([...this.cleanups]);
    await Promise.allSettled([this.storageReady]);
  }

  private snapshot(job: Job) {
    const result = job.state === 'ready' && job.result
      ? job.result.kind === 'file'
        ? { kind: 'file', size: job.result.size, mimeType: job.result.mimeType, fileUrl: `/api/jobs/${job.id}/file` }
        : { kind: 'player', player: job.result.data }
      : undefined;
    return {
      id: job.id, state: job.state, createdAt: new Date(job.createdAt).toISOString(),
      expiresAt: new Date(job.expiresAt).toISOString(), pollAfterMs: 3000, result, error: job.error,
    };
  }

  private timeout(job: Job) {
    if (job.state !== 'queued' && job.state !== 'processing') return;
    job.controller.abort();
    job.state = 'failed';
    job.error = 'Penyiapan melewati batas waktu 9 menit (termasuk antrean). Silakan coba lagi.';
    job.expiresAt = Date.now() + this.limits.ttlMs;
    clearTimeout(job.timer);
  }

  private pump() {
    if (this.closed) return;
    this.sweep();
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.limits.concurrency) break;
      if (job.state !== 'queued') continue;
      job.state = 'processing';
      job.working = true;
      const task = this.run(job);
      this.running.add(task);
      void task.finally(() => { this.running.delete(task); this.pump(); });
    }
  }

  private async run(job: Job) {
    try {
      await this.storageReady;
      job.controller.signal.throwIfAborted();
      const result = await job.work(job.controller.signal);
      job.result = result;
      if (result.kind === 'file') this.storedBytes += result.size;
      if (job.controller.signal.aborted || job.removed) { this.dispose(job); return; }
      if (result.kind === 'file' && (result.size <= 0 || result.size > this.limits.maxFileBytes || this.storedBytes > this.limits.maxStoredBytes)) {
        throw new AppError('File terlalu besar atau penyimpanan job penuh. Coba lagi nanti.', 503);
      }
      if (result.kind === 'file' && this.spoolDir) {
        const destination = path.join(this.spoolDir, `${job.id}.${result.mimeType === 'audio/mpeg' ? 'mp3' : 'mp4'}`);
        await rename(result.path, destination);
        result.path = destination;
        if (job.controller.signal.aborted || job.removed) { this.dispose(job); return; }
      }
      job.state = 'ready';
      job.expiresAt = Date.now() + this.limits.ttlMs;
    } catch (error) {
      this.dispose(job);
      if (job.controller.signal.aborted || job.removed) return;
      job.state = 'failed';
      // Extractor errors may contain cookie paths, command lines and signed URLs.
      job.error = error instanceof AppError && error.statusCode < 500 ? error.message : 'Gagal menyiapkan media. Coba lagi nanti.';
      job.expiresAt = Date.now() + this.limits.ttlMs;
      logger.warn('Background media job failed', { jobId: job.id });
    } finally {
      job.working = false;
      if (job.removed) this.dispose(job);
      clearTimeout(job.timer);
    }
  }

  private remove(job: Job) {
    this.jobs.delete(job.id);
    if (job.key) this.keys.delete(job.key);
    job.removed = true;
    clearTimeout(job.timer);
    if (job.readers === 0 && !job.working) this.dispose(job);
  }

  private async prepareStorage() {
    if (!this.spoolDir) return;
    await mkdir(this.spoolDir, { recursive: true });
    // This spool belongs to one process. After restart the in-memory job tokens
    // no longer exist, so remove only files named by this service.
    for (const name of await readdir(this.spoolDir)) {
      const complete = /^[a-f0-9]{48}\.(mp3|mp4)$/.test(name);
      const partial = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\./.test(name);
      if (complete || partial) await unlink(path.join(this.spoolDir, name));
    }
  }

  private dispose(job: Job) {
    const result = job.result;
    job.result = undefined;
    if (!result) return;
    if (result.kind === 'player') { result.dispose(); return; }
    this.storedBytes -= result.size;
    const task = unlink(result.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') logger.warn('Could not clean up job file', { jobId: job.id });
    });
    this.cleanups.add(task);
    void task.finally(() => this.cleanups.delete(task));
  }
}
