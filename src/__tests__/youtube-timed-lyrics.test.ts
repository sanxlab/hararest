import { EventEmitter } from 'node:events';
import path from 'node:path';
import axios from 'axios';
import { execFile } from 'child_process';
import { YoutubeTimedLyrics } from '../modules/youtube/youtube.timed-lyrics';
import logger from '../utils/logger';
import { config } from '../config/default';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
const command = execFile as unknown as jest.Mock;
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const videoId = 'BFzh21UKNBk';
const url = `https://music.youtube.com/watch?v=${videoId}&si=fixture`;
const lines = [{ timeMs: 131610, text: 'Original last fixture line' }, { timeMs: 1200, text: '検証用の行' }];
const result = {
  text: '[00:01.200]検証用の行\n[02:11.610]Original last fixture line',
  synchronized: [lines[1], lines[0]],
};
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
let previousPython: string | undefined;

function respond(value: unknown) {
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => {
    callback(null, JSON.stringify(value), '');
  });
}

beforeEach(() => {
  command.mockReset();
  previousPython = process.env.PYTHON_BIN;
  delete process.env.PYTHON_BIN;
  respond({ videoId, lines });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousPython === undefined) delete process.env.PYTHON_BIN;
  else process.env.PYTHON_BIN = previousPython;
});

it('preserves and sorts actual millisecond timings with multilingual lyrics', async () => {
  expect(await new YoutubeTimedLyrics().lookup(url, 155)).toEqual(result);
  expect(command).toHaveBeenCalledWith('python3', [
    path.resolve('src/modules/youtube/ytmusic_lyrics.py'), videoId,
  ], expect.objectContaining({ timeout: 15_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' }), expect.any(Function));
  expect(command.mock.calls[0][2]).not.toHaveProperty('shell');
  expect(command.mock.calls[0][2].env.HARAREST_YTMUSIC_COOKIE_PATH).toBe(config.youtube.cookiePath);
});

it('uses the configured Python interpreter without passing credentials or URLs', async () => {
  process.env.PYTHON_BIN = '/opt/media-fallback/bin/python';
  await new YoutubeTimedLyrics().lookup(url, 155);
  expect(command.mock.calls[0][0]).toBe('/opt/media-fallback/bin/python');
  expect(command.mock.calls[0][1]).toEqual([path.resolve('src/modules/youtube/ytmusic_lyrics.py'), videoId]);
});

it.each([
  'https://www.youtube.com/watch?v=BFzh21UKNBk',
  'https://music.youtube.com.evil.test/watch?v=BFzh21UKNBk',
  'https://user:password@music.youtube.com/watch?v=BFzh21UKNBk',
  'https://music.youtube.com:1234/watch?v=BFzh21UKNBk',
  'https://music.youtube.com/playlist?list=BFzh21UKNBk',
  'https://music.youtube.com/watch?v=short',
  'https://music.youtube.com/watch?v=BFzh21UKNBk;echo-secret',
  'file:///tmp/secret', 'invalid',
])('skips an unsupported URL without starting a subprocess: %s', async input => {
  expect(await new YoutubeTimedLyrics().lookup(input, 155)).toBeUndefined();
  expect(command).not.toHaveBeenCalled();
});

it.each([0, -1, 3601, NaN, Infinity])('skips invalid track duration %s', async duration => {
  expect(await new YoutubeTimedLyrics().lookup(url, duration)).toBeUndefined();
  expect(command).not.toHaveBeenCalled();
});

it.each([
  { name: 'wrong video', value: { videoId: 'SVkGRoLicuA', lines } },
  { name: 'wrong shape', value: { videoId, lines: 'not a list' } },
  { name: 'missing ID', value: { lines } },
  { name: 'negative timestamp', value: { videoId, lines: [{ timeMs: -1, text: 'fixture' }] } },
  { name: 'fractional timestamp', value: { videoId, lines: [{ timeMs: 1.5, text: 'fixture' }] } },
  { name: 'timestamp beyond recording', value: { videoId, lines: [{ timeMs: 157001, text: 'fixture' }] } },
  { name: 'non-text line', value: { videoId, lines: [{ timeMs: 100, text: null }] } },
  { name: 'NUL in text', value: { videoId, lines: [{ timeMs: 100, text: 'fixture\0private' }] } },
  { name: 'unpaired surrogate', value: { videoId, lines: [{ timeMs: 100, text: 'fixture\ud800' }] } },
  { name: 'only whitespace', value: { videoId, lines: [{ timeMs: 100, text: '  \n ' }] } },
  { name: 'UTF-8 byte bound', value: { videoId, lines: [{ timeMs: 100, text: '界'.repeat(22_000) }] } },
  { name: 'line count bound', value: { videoId, lines: Array.from({ length: 4001 }, () => ({ timeMs: 0, text: '' })) } },
  { name: 'final LRC size bound', value: { videoId, lines: Array.from({ length: 4000 }, () => ({ timeMs: 0, text: '12345' })) } },
])('rejects an unsuitable timed result: $name', async ({ value }) => {
  respond(value);
  expect(await new YoutubeTimedLyrics().lookup(url, 155)).toBeUndefined();
});

it('accepts a trailing blank line and the two-second endpoint allowance', async () => {
  const timed = [{ timeMs: 0, text: 'Original fixture line' }, { timeMs: 157000, text: '' }];
  respond({ videoId, lines: timed });
  expect(await new YoutubeTimedLyrics().lookup(url, 155)).toEqual({ text: '[00:00.000]Original fixture line\n[02:37.000]', synchronized: timed });
});

it.each(['not JSON', 'x'.repeat(256 * 1024 + 1)])('rejects malformed or oversized helper output', async output => {
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => callback(null, output, ''));
  expect(await new YoutubeTimedLyrics().lookup(url, 155)).toBeUndefined();
});

it('does not cache process or invalid-response failures and never logs their contents', async () => {
  const log = jest.spyOn(logger, 'info');
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => {
    callback(new Error('private-path https://private.test?secret=token'), '', 'private lyrics');
  });
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toBeUndefined();
  respond({ videoId: 'SVkGRoLicuA', lines });
  expect(await client.lookup(url, 155)).toBeUndefined();
  respond({ videoId, lines });
  expect(await client.lookup(url, 155)).toEqual(result);
  expect(command).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|token|検証|BFzh/);
});

it('treats spawn and timeout failures as optional-source misses', async () => {
  command.mockImplementationOnce(() => { throw new Error('private spawn error'); });
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toBeUndefined();
  command.mockImplementationOnce((_bin: string, _args: string[], _options: object, callback: Callback) => {
    callback(Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }), '', '');
  });
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(await client.lookup(url, 155)).toEqual(result);
});

it('caches successful results by exact recording and duration', async () => {
  let now = 100_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toEqual(result);
  expect(await client.lookup(url, 155)).toEqual(result);
  expect(command).toHaveBeenCalledTimes(1);
  await client.lookup(url, 156);
  expect(command).toHaveBeenCalledTimes(2);
  now += 6 * 60 * 60_000 + 1;
  await client.lookup(url, 155);
  expect(command).toHaveBeenCalledTimes(3);
});

it('caches only a legitimate empty result for five minutes', async () => {
  let now = 100_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  respond({ videoId, lines: [] });
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toBeUndefined();
  respond({ videoId, lines });
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(command).toHaveBeenCalledTimes(1);
  now += 5 * 60_000 + 1;
  expect(await client.lookup(url, 155)).toEqual(result);
  expect(command).toHaveBeenCalledTimes(2);
});

it.each([
  'watch_invalid', 'video_mismatch', 'lyrics_ref_missing', 'lyrics_ref_invalid',
  'no_lyrics', 'untimed', 'invalid_lines',
])('logs the allowlisted empty diagnostic and preserves its cache: %s', async detail => {
  const log = jest.spyOn(logger, 'info');
  respond({ videoId, lines: [], reason: detail });
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(log).toHaveBeenCalledWith('YouTube Music timed lyrics', { reason: 'empty', detail });
  respond({ videoId, lines });
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(command).toHaveBeenCalledTimes(1);
});

it.each([
  'https://private.test?secret=token', '', null, 42,
  { secret: 'private' }, ['private'],
])('ignores unknown or malformed helper diagnostics without logging them: %j', async reason => {
  const log = jest.spyOn(logger, 'info');
  respond({ videoId, lines: [], reason });
  const client = new YoutubeTimedLyrics();
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(log).toHaveBeenCalledWith('YouTube Music timed lyrics', { reason: 'empty' });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|token/);
  respond({ videoId, lines });
  expect(await client.lookup(url, 155)).toBeUndefined();
  expect(command).toHaveBeenCalledTimes(1);
});

it('bounds its cache to 128 recordings', async () => {
  command.mockImplementation((_bin: string, args: string[], _options: object, callback: Callback) => callback(null, JSON.stringify({ videoId: args[1], lines: [] }), ''));
  const client = new YoutubeTimedLyrics();
  for (let i = 0; i < 129; i++) await client.lookup(`https://music.youtube.com/watch?v=id${String(i).padStart(9, '0')}`, 155);
  await client.lookup('https://music.youtube.com/watch?v=id000000000', 155);
  expect(command).toHaveBeenCalledTimes(130);
});

it('coalesces queued identical requests and serializes different recordings', async () => {
  const callbacks: Callback[] = [];
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => { callbacks.push(callback); });
  const client = new YoutubeTimedLyrics();
  const first = client.lookup(url, 155);
  const duplicate = client.lookup(url, 155);
  const second = client.lookup('https://music.youtube.com/watch?v=SVkGRoLicuA', 155);
  await tick();
  expect(command).toHaveBeenCalledTimes(1);
  callbacks[0](null, JSON.stringify({ videoId, lines }), '');
  await first;
  await duplicate;
  await tick();
  expect(command).toHaveBeenCalledTimes(2);
  callbacks[1](null, JSON.stringify({ videoId: 'SVkGRoLicuA', lines }), '');
  expect(await second).toEqual(result);
});

it('bounds queued requests without starting excess subprocesses', async () => {
  const callbacks: Callback[] = [];
  const ids: string[] = [];
  command.mockImplementation((_bin: string, args: string[], _options: object, callback: Callback) => { callbacks.push(callback); ids.push(args[1]); });
  const client = new YoutubeTimedLyrics();
  const queued = Array.from({ length: 16 }, (_, i) => client.lookup(`https://music.youtube.com/watch?v=id${String(i).padStart(9, '0')}`, 155));
  expect(await client.lookup(url, 155)).toBeUndefined();
  for (let i = 0; i < 16; i++) {
    await tick();
    expect(command).toHaveBeenCalledTimes(i + 1);
    callbacks[i](null, JSON.stringify({ videoId: ids[i], lines: [] }), '');
  }
  await Promise.all(queued);
});

it('propagates caller cancellation before any process starts', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(new YoutubeTimedLyrics().lookup(url, 155, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(command).not.toHaveBeenCalled();
});

it('retains its process slot until a cancelled child really closes', async () => {
  const callbacks: Callback[] = [];
  const children: Array<EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null }> = [];
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as string | null });
    callbacks.push(callback); children.push(child); return child;
  });
  const client = new YoutubeTimedLyrics();
  const controller = new AbortController();
  const first = client.lookup(url, 155, controller.signal);
  const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = client.lookup('https://music.youtube.com/watch?v=SVkGRoLicuA', 155);
  await tick();
  controller.abort();
  callbacks[0](Object.assign(new Error('private abort'), { name: 'AbortError' }), '', '');
  await tick();
  expect(command).toHaveBeenCalledTimes(1);
  children[0].signalCode = 'SIGKILL';
  children[0].emit('close');
  await cancelled;
  await tick();
  expect(command).toHaveBeenCalledTimes(2);
  children[1].exitCode = 0;
  callbacks[1](null, JSON.stringify({ videoId: 'SVkGRoLicuA', lines }), '');
  expect(await second).toEqual(result);
});

it('does not spawn an already-cancelled queued request', async () => {
  const callbacks: Callback[] = [];
  command.mockImplementation((_bin: string, _args: string[], _options: object, callback: Callback) => { callbacks.push(callback); });
  const client = new YoutubeTimedLyrics();
  const first = client.lookup(url, 155);
  const controller = new AbortController();
  const second = client.lookup('https://music.youtube.com/watch?v=SVkGRoLicuA', 155, controller.signal);
  const cancelled = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  await tick();
  controller.abort();
  callbacks[0](null, JSON.stringify({ videoId, lines }), '');
  await first;
  await cancelled;
  expect(command).toHaveBeenCalledTimes(1);
});

describe('private home helper', () => {
  afterEach(() => {
    delete process.env.YTMUSIC_HELPER_URL;
    delete process.env.YTMUSIC_HELPER_TOKEN;
    delete process.env.TAILSCALE_AUTHKEY;
    jest.restoreAllMocks();
  });

  it('requests the exact video via the local Tailscale proxy', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ data: JSON.stringify({ videoId, lines }) });
    process.env.YTMUSIC_HELPER_URL = 'http://100.112.3.60:20129';
    process.env.YTMUSIC_HELPER_TOKEN = 'x'.repeat(43);
    process.env.TAILSCALE_AUTHKEY = 'fixture';
    expect(await new YoutubeTimedLyrics().lookup(url, 155)).toEqual(result);
    expect(get).toHaveBeenCalledWith(`http://100.112.3.60:20129/lyrics/${videoId}`, expect.objectContaining({
      maxRedirects: 0, timeout: 18000,
      proxy: { protocol: 'http', host: '127.0.0.1', port: 1056 },
    }));
    expect(command).not.toHaveBeenCalled();
  });

  it('rejects an endpoint outside the tailnet before sending its token', async () => {
    const get = jest.spyOn(axios, 'get');
    process.env.YTMUSIC_HELPER_URL = 'http://example.com:20129';
    process.env.YTMUSIC_HELPER_TOKEN = 'x'.repeat(43);
    expect(await new YoutubeTimedLyrics().lookup(url, 155)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it('treats helper downtime as an optional-source miss', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
    process.env.YTMUSIC_HELPER_URL = 'http://100.112.3.60:20129';
    process.env.YTMUSIC_HELPER_TOKEN = 'x'.repeat(43);
    expect(await new YoutubeTimedLyrics().lookup(url, 155)).toBeUndefined();
    expect(command).not.toHaveBeenCalled();
  });
});
