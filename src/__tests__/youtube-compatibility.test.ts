import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';
import app from '../app';
import { YoutubeService } from '../modules/youtube/youtube.service';

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
    if (kind === 'video') expect(method).toHaveBeenCalledWith('https://youtu.be/jNQXAC9IVRw', undefined);
    else expect(method).toHaveBeenCalledWith('https://youtu.be/jNQXAC9IVRw');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('still rejects empty required search parameters', async () => {
  const response = await supertest(app).get('/api/youtube/search?q=');
  expect(response.status).toBe(400);
});
