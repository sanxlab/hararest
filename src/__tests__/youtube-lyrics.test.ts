import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { isYoutubeMusicURL, LyricsClient, YoutubeMusicLyrics } from '../modules/youtube/youtube.lyrics';

const originalLyrics = 'Original fixture lyric line one\nAnother original fixture line';
const track = { title: 'Fixture Song', artist: 'Fixture Artist', album: 'Fixture Album', duration: 120 };
const record = { trackName: track.title, artistName: track.artist, albumName: track.album, duration: 120, instrumental: false, plainLyrics: originalLyrics };
const json = (body: unknown, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });
let request: jest.SpiedFunction<typeof fetch>;
beforeEach(() => { request = jest.spyOn(globalThis, 'fetch'); });
afterEach(() => { jest.restoreAllMocks(); });

it('only enables lyrics enrichment for YouTube Music links', () => {
  expect(isYoutubeMusicURL('https://music.youtube.com/watch?v=example')).toBe(true);
  for (const value of ['https://www.youtube.com/watch?v=example', 'https://youtu.be/example', 'https://music.youtube.com.evil.test/watch', 'invalid']) {
    expect(isYoutubeMusicURL(value)).toBe(false);
  }
});

it('looks up exact song metadata, identifies the app and caches matching lyrics', async () => {
  request.mockResolvedValueOnce(json(record));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBe(originalLyrics);
  expect(await client.lookup(track)).toBe(originalLyrics);
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  const endpoint = new URL(String(url));
  expect(endpoint.origin + endpoint.pathname).toBe('https://lrclib.net/api/get');
  expect(Object.fromEntries(endpoint.searchParams)).toEqual({ track_name: track.title, artist_name: track.artist, album_name: track.album, duration: '120' });
  expect(init).toMatchObject({ redirect: 'error', headers: { 'User-Agent': expect.stringContaining('Hararest') } });
});

it('handles artist Topic suffix and converts LRC-only results into plain lyrics', async () => {
  request.mockResolvedValueOnce(json({ ...record, plainLyrics: null, syncedLyrics: '[ar:Fixture Artist]\n[00:01.00]First original fixture line\n[00:02.50]Second original fixture line' }));
  expect(await new LyricsClient().lookup({ ...track, artist: 'Fixture Artist - Topic' })).toBe('First original fixture line\nSecond original fixture line');
});

it.each([
  { name: 'different title/version', response: { ...record, trackName: 'Fixture Song (Live)' } },
  { name: 'different artist', response: { ...record, artistName: 'Another Artist' } },
  { name: 'different album', response: { ...record, albumName: 'Other Album' } },
  { name: 'different duration', response: { ...record, duration: 123 } },
  { name: 'instrumental', response: { ...record, instrumental: true } },
  { name: 'missing lyrics', response: { ...record, plainLyrics: null } },
  { name: 'malformed record', response: { trackName: 123 } },
  { name: 'oversized unicode lyrics', response: { ...record, plainLyrics: '界'.repeat(30_000) } },
])('does not embed $name', async ({ response }) => {
  request.mockResolvedValueOnce(json(response));
  expect(await new LyricsClient().lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('accepts a duration difference within two seconds', async () => {
  request.mockResolvedValueOnce(json({ ...record, duration: 121.5 }));
  expect(await new LyricsClient().lookup(track)).toBe(originalLyrics);
});

it.each([429, 503])('honors Retry-After without repeatedly requesting a throttled service (%s)', async status => {
  request.mockResolvedValueOnce(json({}, status, { 'retry-after': '60' }));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup({ ...track, title: 'Other Song' })).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('caches a missing track and skips incomplete song metadata', async () => {
  request.mockResolvedValueOnce(json({}, 404));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup({ ...track, artist: '' })).toBeUndefined();
  expect(await client.lookup({ ...track, duration: 3601 })).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('rejects oversized responses and does not request on caller cancellation', async () => {
  request.mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
  await expect(new LyricsClient().lookup(track)).rejects.toMatchObject({ statusCode: 502 });
  const controller = new AbortController();
  controller.abort();
  await expect(new LyricsClient().lookup(track, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledTimes(1);
});

const run = promisify(execFile);
const hasMediaTools = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0);
const mediaTest = hasMediaTools ? it : it.skip;

mediaTest.each(['found', 'found-v4', 'missing', 'unavailable', 'malformed', 'too-large', 'ordinary-youtube'] as const)(
  'keeps MP3 playable, existing metadata and cover intact when lyrics are %s', async state => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-lyrics-'));
    try {
      const cover = path.join(directory, 'cover.png');
      const file = path.join(directory, 'song.mp3');
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-threads', '1', cover]);
      await run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', cover,
        '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic',
        '-id3v2_version', state === 'found-v4' ? '4' : '3', '-metadata', `title=${track.title}`, '-metadata', `artist=${track.artist}`,
        '-metadata', `album=${track.album}`, '-metadata', 'track=3', '-metadata', 'purl=https://music.youtube.com/watch?v=fixture', file,
      ]);
      const before = fs.readFileSync(file);
      const beforeAudio = (await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
      const lyrics = `${originalLyrics}\nartist=must not overwrite artist\nSymbols: # ; = \\ 日本語`;
      request.mockImplementation(async url => {
        const query = new URL(String(url)).searchParams;
        if (state === 'unavailable') throw new Error('lyrics service down');
        if (state === 'malformed') return new Response('bad JSON', { headers: { 'content-type': 'application/json' } });
        if (state === 'missing') return json({}, 404);
        return json({ ...record, duration: Number(query.get('duration')), plainLyrics: lyrics });
      });
      await new YoutubeMusicLyrics().enrich(file, state === 'ordinary-youtube' ? 'https://www.youtube.com/watch?v=fixture' : 'https://music.youtube.com/watch?v=fixture', {
        maxBytes: state === 'too-large' ? before.length : 256 * 1024 * 1024,
      });
      const result = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', file])).stdout) as {
        format: { tags: Record<string, string> }; streams: Array<{ disposition: { attached_pic: number } }>;
      };
      expect(result.format.tags).toMatchObject({ title: track.title, artist: track.artist, album: track.album, track: '3', purl: 'https://music.youtube.com/watch?v=fixture' });
      expect(result.streams.some(stream => stream.disposition.attached_pic === 1)).toBe(true);
      if (state === 'found' || state === 'found-v4') {
        expect(Object.entries(result.format.tags).find(([key]) => /^lyrics(?:-|$)/i.test(key))?.[1]).toBe(lyrics);
        expect(fs.readFileSync(file).toString('ascii', 10, 14)).toBe('USLT');
      } else {
        expect(Object.keys(result.format.tags).some(key => /^lyrics(?:-|$)/i.test(key))).toBe(false);
        expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
      }
      const afterAudio = (await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
      expect(afterAudio).toBe(beforeAudio);
      expect(fs.readdirSync(directory).sort()).toEqual(['cover.png', 'song.mp3']);
      if (state === 'ordinary-youtube') expect(request).not.toHaveBeenCalled();
      if (state === 'found') {
        request.mockClear();
        const tagged = fs.readFileSync(file);
        await new YoutubeMusicLyrics().enrich(file, 'https://music.youtube.com/watch?v=fixture', { maxBytes: 256 * 1024 * 1024 });
        expect(request).not.toHaveBeenCalled();
        expect(fs.readFileSync(file)).toEqual(tagged);
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30_000,
);
