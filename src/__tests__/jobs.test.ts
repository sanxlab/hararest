import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { JobResult, JobService, JOB_LIMITS } from '../modules/jobs/jobs.service';
import { createJobRoutes } from '../modules/jobs/jobs.route';
import { YoutubeService } from '../modules/youtube/youtube.service';
import { PlayerService } from '../modules/player/player.service';
import { errorHandler } from '../middlewares/error.middleware';
import { jobStatusLimiter } from '../middlewares/ratelimit.middleware';
import realApp from '../app';

const source = 'https://youtu.be/jNQXAC9IVRw';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let directory: string;
let jobs: JobService;
let player: PlayerService;
let youtube: jest.Mocked<Pick<YoutubeService, 'downloadAudio' | 'downloadVideo'>>;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-test-'));
  jobs = new JobService();
  youtube = { downloadAudio: jest.fn(), downloadVideo: jest.fn() };
  player = new PlayerService({ search: jest.fn(), getInfo: jest.fn(), downloadAudio: jest.fn() }, 'https://api.example.com');
});
afterEach(async () => {
  await jobs.close();
  player.close();
  jest.restoreAllMocks();
  jest.useRealTimers();
  await fs.rm(directory, { recursive: true, force: true });
});

function app() {
  const app = express();
  app.use(express.json());
  const routes = createJobRoutes(jobs, youtube, player);
  app.post('/api/youtube/jobs', routes.createDownload);
  app.post('/api/player/jobs', routes.createPlayer);
  app.use('/api/jobs', jobStatusLimiter, routes.statusRouter);
  app.use(errorHandler);
  return app;
}

async function ready(id: string) {
  for (let i = 0; i < 100; i++) {
    if (!['queued', 'processing'].includes(jobs.get(id).state)) return jobs.get(id);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Job did not finish');
}

it('returns 202 before extraction finishes; polls and downloads the same completed file twice', async () => {
  const file = path.join(directory, 'audio.mp3');
  const audio = Buffer.from('audio fixture');
  await fs.writeFile(file, audio);
  const pending = deferred<string>();
  youtube.downloadAudio.mockReturnValue(pending.promise);
  const api = supertest(app());
  const response = await api.post('/api/youtube/jobs').set('Idempotency-Key', 'test-download-key-123').send({ url: source, format: 'audio' });
  expect(response.status).toBe(202);
  expect(response.headers['cache-control']).toBe('no-store');
  const id = response.body.data.id;
  expect((await api.get(`/api/jobs/${id}`)).body.data.state).toBe('processing');
  expect((await api.get(`/api/jobs/${id}/file`)).status).toBe(409);
  // A lost POST response can be retried without creating another extractor.
  const retry = await api.post('/api/youtube/jobs').set('Idempotency-Key', 'test-download-key-123').send({ url: source, format: 'audio' });
  expect(retry.body.data.id).toBe(id);
  pending.resolve(file);
  expect((await ready(id)).state).toBe('ready');
  const status = await api.get(`/api/jobs/${id}`);
  expect(status.body.data.result).toMatchObject({ kind: 'file', size: audio.length, fileUrl: `/api/jobs/${id}/file` });
  expect(JSON.stringify(status.body)).not.toContain(directory);
  for (let i = 0; i < 2; i++) {
    const download = await api.get(`/api/jobs/${id}/file`);
    expect(download.status).toBe(200);
    expect(download.body).toEqual(audio);
  }
  expect(youtube.downloadAudio).toHaveBeenCalledTimes(1);
  expect(youtube.downloadAudio).toHaveBeenCalledWith(source, { signal: expect.any(AbortSignal), maxBytes: JOB_LIMITS.maxFileBytes });
});

it('preserves video quality and passes cancellation to the video extractor', async () => {
  const file = path.join(directory, 'video.mp4');
  await fs.writeFile(file, 'video');
  youtube.downloadVideo.mockResolvedValue(file);
  const response = await supertest(app()).post('/api/youtube/jobs').send({ url: source, format: 'video', quality: '720p' });
  expect((await ready(response.body.data.id)).state).toBe('ready');
  expect(youtube.downloadVideo).toHaveBeenCalledWith(source, '720p', { signal: expect.any(AbortSignal), maxBytes: JOB_LIMITS.maxFileBytes });
});

it('prepares player sessions on the shared queue and returns HTML with the API origin', async () => {
  const prepare = jest.spyOn(player, 'prepare').mockResolvedValue({ id: 'player-id', title: 'Title', artist: 'Artist', duration: 19, size: 100, mimeType: 'audio/mpeg', expiresAt: new Date(Date.now() + 60_000).toISOString(), wsUrl: 'ws://127.0.0.1:1337/ws/player/player-id', playerUrl: 'http://127.0.0.1:1337/player/player-id' });
  const response = await supertest(app()).post('/api/player/jobs').send({ query: 'song', baseUrl: 'http://127.0.0.1:1337' });
  expect(response.status).toBe(202);
  const job = await ready(response.body.data.id);
  expect(job.result).toMatchObject({ kind: 'player', player: { title: 'Title', html: expect.stringContaining('KOTONEHARA') } });
  expect(prepare).toHaveBeenCalledWith('song', expect.any(AbortSignal), 'http://127.0.0.1:1337');
});

it.each([
  {}, { url: source, format: 'exe' }, { url: 'http://localhost/private', format: 'audio' },
  { url: 'https://youtube.com.evil.test/v', format: 'audio' }, { url: 'https://user:pass@youtube.com/v', format: 'audio' },
  { url: source, format: 'video', quality: '--exec=evil' }, { url: source, format: 'audio', extra: true },
])('rejects invalid jobs without invoking yt-dlp: %j', async body => {
  expect((await supertest(app()).post('/api/youtube/jobs').send(body)).status).toBe(400);
  expect(youtube.downloadAudio).not.toHaveBeenCalled();
  expect(youtube.downloadVideo).not.toHaveBeenCalled();
});

it('isolates status polling from the API/download rate limit', async () => {
  // No job exists, but every read must remain 410 instead of hitting the 10/min
  // download or 60/min API limiter inherited by the old synchronous routes.
  for (let i = 0; i < 65; i++) {
    expect((await supertest(realApp).get('/api/jobs/' + 'a'.repeat(48))).status).toBe(410);
  }
});

it('enforces capacity and prevents idempotency-key reuse with different input', async () => {
  await jobs.close();
  jobs = new JobService({ ...JOB_LIMITS, concurrency: 1, maxJobs: 2 });
  const a = deferred<JobResult>(), b = deferred<JobResult>();
  const first = jest.fn().mockReturnValue(a.promise), second = jest.fn().mockReturnValue(b.promise);
  const one = jobs.submit('one', first, 'same-key-12345678');
  expect(jobs.submit('one', first, 'same-key-12345678').id).toBe(one.id);
  expect(() => jobs.submit('different', first, 'same-key-12345678')).toThrow('permintaan berbeda');
  const two = jobs.submit('two', second);
  expect(() => jobs.submit('three', second)).toThrow('penuh');
  await tick();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  a.reject(new Error('private cookie path should never reach client'));
  await ready(one.id);
  expect(jobs.get(one.id)).toMatchObject({ state: 'failed', error: 'Gagal menyiapkan media. Coba lagi nanti.' });
  await tick();
  expect(second).toHaveBeenCalledTimes(1);
  b.reject(new Error('failed'));
  await ready(two.id);
});

it('aborts work at its deadline without freeing the worker slot prematurely', async () => {
  await jobs.close();
  jobs = new JobService({ ...JOB_LIMITS, concurrency: 1 });
  jest.useFakeTimers();
  const pending = deferred<JobResult>();
  const work = jest.fn().mockReturnValue(pending.promise);
  const job = jobs.submit('timeout', work);
  await jest.advanceTimersByTimeAsync(1);
  const signal = work.mock.calls[0][0] as AbortSignal;
  await jest.advanceTimersByTimeAsync(126_000);
  expect(jobs.get(job.id).state).toBe('processing');
  await jest.advanceTimersByTimeAsync(JOB_LIMITS.timeoutMs);
  expect(signal.aborted).toBe(true);
  expect(jobs.get(job.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('batas waktu') });
  const nextWork = jest.fn().mockResolvedValue({ kind: 'player', data: {}, dispose: () => undefined });
  jobs.submit('next job', nextWork);
  await jest.advanceTimersByTimeAsync(1);
  expect(nextWork).not.toHaveBeenCalled();
  pending.reject(new Error('aborted'));
  await jest.advanceTimersByTimeAsync(1);
  expect(nextWork).toHaveBeenCalledTimes(1);
});

it('expires results, frees capacity, and defers file cleanup until readers finish', async () => {
  const file = path.join(directory, 'audio.mp3');
  await fs.writeFile(file, 'audio');
  const job = jobs.submit('audio', async () => ({ kind: 'file', path: file, size: 5, mimeType: 'audio/mpeg' }));
  await ready(job.id);
  const lease = jobs.acquireFile(job.id);
  const future = Date.now() + JOB_LIMITS.ttlMs + 1;
  jest.spyOn(Date, 'now').mockReturnValue(future);
  expect(() => jobs.get(job.id)).toThrow('kedaluwarsa');
  expect(await fs.readFile(file, 'utf8')).toBe('audio');
  lease.release();
  await jobs.close();
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans up oversized outputs instead of returning a file', async () => {
  await jobs.close();
  jobs = new JobService({ ...JOB_LIMITS, maxFileBytes: 4 });
  const file = path.join(directory, 'too-big.mp3');
  await fs.writeFile(file, 'audio');
  const job = jobs.submit('big', async () => ({ kind: 'file', path: file, size: 5, mimeType: 'audio/mpeg' }));
  expect((await ready(job.id)).state).toBe('failed');
  await jobs.close();
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cleans owned orphan files at startup and retained files at shutdown', async () => {
  await jobs.close();
  const spool = path.join(directory, 'jobs');
  await fs.mkdir(spool);
  await fs.writeFile(path.join(spool, 'a'.repeat(48) + '.mp3'), 'orphan');
  await fs.writeFile(path.join(spool, '12345678-1234-1234-1234-123456789abc.f140.m4a.part'), 'partial');
  await fs.writeFile(path.join(spool, 'keep.txt'), 'other');
  const file = path.join(directory, 'audio.mp3');
  await fs.writeFile(file, 'audio');
  jobs = new JobService(JOB_LIMITS, spool);
  const job = jobs.submit('audio', async () => ({ kind: 'file', path: file, size: 5, mimeType: 'audio/mpeg' }));
  expect((await ready(job.id)).state).toBe('ready');
  expect((await fs.readdir(spool)).sort()).toEqual([job.id + '.mp3', 'keep.txt'].sort());
  await jobs.close();
  expect(await fs.readdir(spool)).toEqual(['keep.txt']);
});
