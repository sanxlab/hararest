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
  expect(await client.lookup(track)).toEqual({ text: originalLyrics, synchronized: [] });
  expect(await client.lookup(track)).toEqual({ text: originalLyrics, synchronized: [] });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0];
  const endpoint = new URL(String(url));
  expect(endpoint.origin + endpoint.pathname).toBe('https://lrclib.net/api/get');
  expect(Object.fromEntries(endpoint.searchParams)).toEqual({ track_name: track.title, artist_name: track.artist, album_name: track.album, duration: '120' });
  expect(init).toMatchObject({ redirect: 'error', headers: { 'User-Agent': expect.stringContaining('Hararest') } });
});

it('handles artist Topic suffix and retains LRC timestamps with millisecond timing', async () => {
  request.mockResolvedValueOnce(json({ ...record, plainLyrics: null, syncedLyrics: '[ar:Fixture Artist]\n[00:01.00]First original fixture line\n[00:02.50]Second original fixture line' }));
  expect(await new LyricsClient().lookup({ ...track, artist: 'Fixture Artist - Topic' })).toEqual({ text: '[ar:Fixture Artist]\n[00:01.00]First original fixture line\n[00:02.50]Second original fixture line', synchronized: [{ timeMs: 1000, text: 'First original fixture line' }, { timeMs: 2500, text: 'Second original fixture line' }] });
});

it('prefers available timed lyrics over plain text and expands repeated LRC timestamps', async () => {
  const lrc = '[00:01.1][00:03.123]Original repeated fixture line\n[00:02.12]Original middle fixture line';
  request.mockResolvedValueOnce(json({ ...record, syncedLyrics: lrc }));
  expect(await new LyricsClient().lookup(track)).toEqual({ text: lrc, synchronized: [
    { timeMs: 1100, text: 'Original repeated fixture line' },
    { timeMs: 2120, text: 'Original middle fixture line' },
    { timeMs: 3123, text: 'Original repeated fixture line' },
  ] });
});

it('bounds repeated-timestamp expansion before constructing SYLT frames', async () => {
  const syncedLyrics = '[00:01.00]'.repeat(100) + 'Original fixture '.repeat(300);
  request.mockResolvedValueOnce(json({ ...record, syncedLyrics }));
  expect(await new LyricsClient().lookup(track)).toEqual({ text: originalLyrics, synchronized: [] });
});

it.each(['[00:61.00]Invalid seconds', '[03:00.00]Beyond this recording', '[offset:20]\n[00:01.00]Unapplied offset'])(
  'falls back to plain lyrics instead of inventing unsupported timing: %s', async syncedLyrics => {
    request.mockResolvedValueOnce(json({ ...record, syncedLyrics }));
    expect(await new LyricsClient().lookup(track)).toEqual({ text: originalLyrics, synchronized: [] });
  },
);

function timedEntries(file: string): { timeFormat: number; contentType: number; lines: Array<{ text: string; timeMs: number }> } | undefined {
  const bytes = fs.readFileSync(file);
  const version = bytes[3];
  for (let offset = 10; offset + 10 < bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) return;
    const size = version === 3 ? bytes.readUInt32BE(offset + 4) : bytes[offset + 4] * 0x200000 + bytes[offset + 5] * 0x4000 + bytes[offset + 6] * 0x80 + bytes[offset + 7];
    if (id === 'SYLT') {
      const body = bytes.subarray(offset + 10, offset + 10 + size);
      expect(body[0]).toBe(1);
      expect(body.toString('ascii', 1, 4)).toBe('und');
      const lines: Array<{ text: string; timeMs: number }> = [];
      // encoding/lang/time format/content type + empty UTF-16 descriptor = 10 bytes.
      for (let cursor = 10; cursor < body.length;) {
        let end = cursor;
        while (end + 1 < body.length && body.readUInt16LE(end) !== 0) end += 2;
        const text = body.toString('utf16le', cursor, end).replace(/^\uFEFF/, '');
        lines.push({ text, timeMs: body.readUInt32BE(end + 2) });
        cursor = end + 6;
      }
      return { timeFormat: body[4], contentType: body[5], lines };
    }
    offset += 10 + size;
  }
}

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
  expect(await new LyricsClient().lookup(track)).toEqual({ text: originalLyrics, synchronized: [] });
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

mediaTest.each(['found', 'found-v4', 'found-synced', 'found-synced-v4', 'found-japanese', 'found-empty-existing', 'missing', 'unavailable', 'malformed', 'too-large', 'ordinary-youtube'] as const)(
  'keeps MP3 playable, existing metadata and cover intact when lyrics are %s', async state => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-lyrics-'));
    try {
      const cover = path.join(directory, 'cover.png');
      const file = path.join(directory, 'song.mp3');
      const metadata = state === 'found-japanese'
        ? { ...track, title: '試験曲', artist: '架空の歌手', album: '試験集' }
        : track;
      await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-threads', '1', cover]);
      await run('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-i', cover,
        '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic',
        '-id3v2_version', state.endsWith('-v4') ? '4' : '3', '-metadata', `title=${metadata.title}`, '-metadata', `artist=${metadata.artist}`,
        '-metadata', `album=${metadata.album}`, '-metadata', 'track=3', '-metadata', 'purl=https://music.youtube.com/watch?v=fixture',
        ...(state === 'found-empty-existing' ? ['-metadata', 'lyrics=   '] : []), file,
      ]);
      const before = fs.readFileSync(file);
      const beforeAudio = (await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'])).stdout;
      const lyrics = `${originalLyrics}\nartist=must not overwrite artist\nSymbols: # ; = \\ 日本語`;
      const lrc = '[00:00.00]Original first fixture line\n[00:00.45]Original 日本語 fixture line';
      const synced = state.startsWith('found-synced') || state === 'found-japanese';
      request.mockImplementation(async url => {
        const query = new URL(String(url)).searchParams;
        if (state === 'unavailable') throw new Error('lyrics service down');
        if (state === 'malformed') return new Response('bad JSON', { headers: { 'content-type': 'application/json' } });
        if (state === 'missing') return json({}, 404);
        expect(query.get('track_name')).toBe(metadata.title);
        expect(query.get('artist_name')).toBe(metadata.artist);
        return json({ ...record, trackName: metadata.title, artistName: metadata.artist, albumName: metadata.album,
          duration: Number(query.get('duration')), plainLyrics: lyrics, ...(synced ? { syncedLyrics: lrc } : {}) });
      });
      await new YoutubeMusicLyrics().enrich(file, state === 'ordinary-youtube' ? 'https://www.youtube.com/watch?v=fixture' : 'https://music.youtube.com/watch?v=fixture', {
        maxBytes: state === 'too-large' ? before.length : 256 * 1024 * 1024,
      });
      const result = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', file])).stdout) as {
        format: { tags: Record<string, string> }; streams: Array<{ disposition: { attached_pic: number } }>;
      };
      expect(result.format.tags).toMatchObject({ title: metadata.title, artist: metadata.artist, album: metadata.album, track: '3', purl: 'https://music.youtube.com/watch?v=fixture' });
      expect(result.streams.some(stream => stream.disposition.attached_pic === 1)).toBe(true);
      if (state.startsWith('found')) {
        expect(Object.entries(result.format.tags).find(([key]) => /^lyrics(?:-|$)/i.test(key))?.[1]).toBe(synced ? lrc : lyrics);
        expect(fs.readFileSync(file).toString('ascii', 10, 14)).toBe('USLT');
        if (synced) expect(timedEntries(file)).toEqual({ timeFormat: 2, contentType: 1, lines: [
          { text: 'Original first fixture line', timeMs: 0 },
          { text: 'Original 日本語 fixture line', timeMs: 450 },
        ] });
        else expect(timedEntries(file)).toBeUndefined();
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
