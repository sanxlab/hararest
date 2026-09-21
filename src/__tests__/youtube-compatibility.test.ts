import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import app from '../app';
import { YoutubeService } from '../modules/youtube/youtube.service';
import { EventEmitter } from 'node:events';
import { Request, Response } from 'express';
import { downloadAudioHandler, downloadVideoHandler } from '../modules/youtube/youtube.controller';

jest.mock('../modules/youtube/youtube.service');

it.each(['audio', 'video'])('supports legacy bot requests with empty quality for %s', async (kind) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-compat-'));
  try {
    const file = path.join(directory, kind === 'audio' ? 'test.mp3' : 'test.mp4');
    fs.writeFileSync(file, 'media fixture');
    const method = kind === 'audio' ? YoutubeService.prototype.downloadAudio : YoutubeService.prototype.downloadVideo;
    (method as jest.Mock).mockResolvedValue(file);
    const response = await supertest(app).get(`/api/youtube/${kind}`).query({ url: 'https://youtu.be/jNQXAC9IVRw', quality: '' });
    expect(response.status).toBe(200);
    if (kind === 'video') expect(method).toHaveBeenCalledWith('https://youtu.be/jNQXAC9IVRw', undefined, { signal: expect.any(AbortSignal) });
    else expect(method).toHaveBeenCalledWith('https://youtu.be/jNQXAC9IVRw', { signal: expect.any(AbortSignal) });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('still rejects empty required search parameters', async () => {
  const response = await supertest(app).get('/api/youtube/search?q=');
  expect(response.status).toBe(400);
});

it.each(['audio', 'video'])('cancels legacy %s extraction after disconnect and removes a late output', async (kind) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-disconnect-'));
  try {
    const file = path.join(directory, kind === 'audio' ? 'late.mp3' : 'late.mp4');
    fs.writeFileSync(file, 'media fixture');
    let resolveDownload!: (file: string) => void;
    const pendingDownload = new Promise<string>(resolve => { resolveDownload = resolve; });
    const method = kind === 'audio' ? YoutubeService.prototype.downloadAudio : YoutubeService.prototype.downloadVideo;
    (method as jest.Mock).mockReturnValueOnce(pendingDownload);
    const req = { query: { url: 'https://youtu.be/jNQXAC9IVRw' }, setTimeout: jest.fn() } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, setTimeout: jest.fn(), download: jest.fn() }) as unknown as Response;
    const next = jest.fn();
    const pending = (kind === 'audio' ? downloadAudioHandler : downloadVideoHandler)(req, res, next);
    const options = (method as jest.Mock).mock.calls.at(-1).at(-1) as { signal: AbortSignal };
    expect(options.signal.aborted).toBe(false);
    Object.assign(res, { destroyed: true });
    res.emit('close');
    expect(options.signal.aborted).toBe(true);
    resolveDownload(file);
    await pending;
    expect(fs.existsSync(file)).toBe(false);
    expect(res.download).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
