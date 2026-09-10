import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { WebSocket } from 'ws';
import { YoutubeService } from '../modules/youtube/youtube.service';
import { VideoInfo } from '../modules/youtube/youtube.types';
import { PlayerService } from '../modules/player/player.service';
import { createPlayerRouters } from '../modules/player/player.route';
import { attachPlayerWebSocket } from '../modules/player/player.websocket';
import { errorHandler } from '../middlewares/error.middleware';

const URL_A = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const URL_B = 'https://www.youtube.com/watch?v=BaW_jenozKc';
const audioA = Buffer.alloc(150_001, 65);
const audioB = Buffer.alloc(81_000, 66);
let directory: string;
let youtube: jest.Mocked<Pick<YoutubeService, 'search' | 'getInfo' | 'downloadAudio'>>;
let service: PlayerService;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'player-test-'));
  youtube = {
    search: jest.fn().mockResolvedValue([{ id: 'jNQXAC9IVRw' }]),
    getInfo: jest.fn().mockImplementation(async (url) => ({ title: url === URL_A ? 'Song A' : 'Song B', duration: 19, channel: { name: 'Artist' } } as VideoInfo)),
    downloadAudio: jest.fn().mockImplementation(async (url) => {
      const file = path.join(directory, `${randomUUID()}.mp3`);
      await fs.writeFile(file, url === URL_A ? audioA : audioB);
      return file;
    }),
  };
  service = new PlayerService(youtube, 'https://api.example.com');
});

afterEach(async () => {
  service.close();
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('stores separate audio sessions, derives WSS on the API origin, and removes temporary downloads', async () => {
  const a = await service.prepare('song title');
  const b = await service.prepare(URL_B);
  expect(a.id).not.toBe(b.id);
  expect(a.wsUrl).toBe(`wss://api.example.com/ws/player/${a.id}`);
  expect(a.playerUrl).toBe(`https://api.example.com/player/${a.id}`);
  expect(service.get(a.id)?.audio).toEqual(audioA);
  expect(service.get(b.id)?.audio).toEqual(audioB);
  expect(youtube.search).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(directory)).toEqual([]);
});

it.each([undefined, '', '  ', [], { query: 'test' }, 'x'.repeat(501)])('rejects invalid queries before downloading: %j', async (query) => {
  await expect(service.prepare(query)).rejects.toMatchObject({ statusCode: 400 });
  expect(youtube.getInfo).not.toHaveBeenCalled();
});

it('rejects a source URL outside YouTube before invoking an extractor', async () => {
  await expect(service.prepare('https://example.com/private')).rejects.toMatchObject({ statusCode: 403 });
  expect(youtube.getInfo).not.toHaveBeenCalled();
});

it.each([0, 601, Infinity])('rejects unavailable/live/long durations: %s', async (duration) => {
  youtube.getInfo.mockResolvedValue({ duration } as VideoInfo);
  await expect(service.prepare(URL_A)).rejects.toMatchObject({ statusCode: 422 });
  expect(youtube.downloadAudio).not.toHaveBeenCalled();
});

it('expires sessions and frees capacity', async () => {
  let now = 1000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  service = new PlayerService(youtube, 'https://api.example.com', { ttlMs: 100, maxSessions: 1, maxBytes: 200_000, maxDuration: 600, maxPending: 1 });
  const track = await service.prepare(URL_A);
  await expect(service.prepare(URL_B)).rejects.toMatchObject({ statusCode: 503 });
  now = 1100;
  expect(service.get(track.id)).toBeUndefined();
  await expect(service.prepare(URL_B)).resolves.toMatchObject({ title: 'Song B' });
});

it('reserves capacity before async preparation starts', async () => {
  service = new PlayerService(youtube, 'https://api.example.com', { ttlMs: 1000, maxSessions: 8, maxBytes: 200_000, maxDuration: 600, maxPending: 1 });
  const first = service.prepare(URL_A);
  await expect(service.prepare(URL_B)).rejects.toMatchObject({ statusCode: 503 });
  await first;
});

it('removes a downloaded file rejected for size', async () => {
  service = new PlayerService(youtube, 'https://api.example.com', { ttlMs: 1000, maxSessions: 8, maxBytes: 100, maxDuration: 600, maxPending: 2 });
  await expect(service.prepare(URL_A)).rejects.toMatchObject({ statusCode: 422 });
  expect(await fs.readdir(directory)).toEqual([]);
});

it('propagates cancellation and cleans the finished download without retaining a session', async () => {
  const controller = new AbortController();
  youtube.downloadAudio.mockImplementation(async (_url, options) => {
    expect(options?.signal).toBe(controller.signal);
    const file = path.join(directory, 'cancelled.mp3');
    await fs.writeFile(file, audioA);
    controller.abort();
    return file;
  });
  await expect(service.prepare(URL_A, controller.signal)).rejects.toMatchObject({ statusCode: 408 });
  expect(youtube.getInfo).toHaveBeenCalledWith(URL_A, controller.signal);
  expect(await fs.readdir(directory)).toEqual([]);
});

it('uses the bot API base URL by default and rejects non-origin values', async () => {
  service = new PlayerService(youtube, '');
  await expect(service.prepare(URL_A, undefined, 'http://127.0.0.1:1337')).resolves.toMatchObject({ wsUrl: expect.stringContaining('ws://127.0.0.1:1337/ws/player/') });
  for (const base of ['javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?key=secret']) {
    await expect(service.prepare(URL_A, undefined, base)).rejects.toMatchObject({ statusCode: 400 });
  }
});

function testApp() {
  const app = express();
  app.use(express.json());
  const routers = createPlayerRouters(service);
  app.use('/api/player', routers.apiRouter);
  app.use('/player', routers.pageRouter);
  app.use(errorHandler);
  return app;
}

it('returns a usable session and escapes metadata in both HTML text and embedded JSON', async () => {
  const attack = '</script><script>window.injected=true</script>';
  youtube.getInfo.mockResolvedValue({ title: attack, duration: 19, channel: { name: '<img src=x onerror=alert(1)>' } } as VideoInfo);
  const app = testApp();
  const result = await supertest(app).post('/api/player/sessions').send({ query: URL_A });
  expect(result.status).toBe(201);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body.data.html).not.toContain(attack);
  expect(result.body.data.html).toContain('&lt;/script&gt;');
  expect(result.body.data.html).toContain('\\u003c/script>');
  const page = await supertest(app).get(`/player/${result.body.data.id}`);
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toContain('connect-src wss://api.example.com');
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  service.remove(result.body.data.id);
  expect((await supertest(app).get(`/player/${result.body.data.id}`)).status).toBe(410);
});

describe('WebSocket audio protocol', () => {
  let server: Server;
  let closePlayer: () => void;
  let base: string;
  beforeEach(async () => {
    server = createServer(testApp());
    closePlayer = attachPlayerWebSocket(server, service);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    base = `ws://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    closePlayer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function receive(id: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws/player/${id}`);
      const chunks: Buffer[] = [];
      let expected = 0;
      ws.on('error', reject);
      ws.on('message', (data, binary) => {
        if (!binary) {
          const message = JSON.parse(data.toString());
          if (message.type === 'start') expected = message.totalChunks;
          if (message.type === 'end') {
            if (chunks.length !== expected) return reject(new Error('Incomplete frames'));
            resolve(Buffer.concat(chunks));
          }
        } else {
          const frame = Buffer.from(data as Buffer);
          chunks[frame.readUInt32BE(0)] = frame.subarray(4);
        }
      });
    });
  }

  it('serves HTTP and isolates two simultaneous audio streams on the same port', async () => {
    const a = await service.prepare(URL_A);
    const b = await service.prepare(URL_B);
    const [receivedA, receivedB] = await Promise.all([receive(a.id), receive(b.id)]);
    expect(receivedA).toEqual(audioA);
    expect(receivedB).toEqual(audioB);
    expect((await supertest(server).get(`/player/${a.id}`)).status).toBe(200);
  });

  it('rejects expired/unknown sessions before upgrading', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws/player/${'a'.repeat(48)}`);
      ws.on('error', () => {});
      ws.on('open', () => reject(new Error('Unexpected upgrade')));
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode || 0); });
    });
    expect(status).toBe(410);
  });
});
