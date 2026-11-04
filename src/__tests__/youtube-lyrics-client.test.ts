import { setTimeout as delay } from 'node:timers/promises';
import { LyricsClient } from '../modules/youtube/youtube.lyrics';
import logger from '../utils/logger';

jest.mock('node:timers/promises', () => ({ setTimeout: jest.fn() }));

const wait = delay as unknown as jest.Mock;
const track = { title: 'Sukidakara', artist: 'Yuika', album: 'Sukidakara', duration: 298.663771 };
// Original synthetic text, never copied from a song or provider response.
const lrc = '[00:01.20]検証用の日本語の行';
const record = { trackName: track.title, artistName: track.artist, albumName: track.album, duration: 298, instrumental: false, syncedLyrics: lrc };
const expected = { text: lrc, synchronized: [{ timeMs: 1200, text: '検証用の日本語の行' }] };
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
let request: jest.SpiedFunction<typeof fetch>;
let log: jest.SpiedFunction<typeof logger.info>;
let now: number;

function loggedReason(reason: string): boolean {
  const calls: ReadonlyArray<readonly unknown[]> = log.mock.calls;
  return calls.some(call => {
    const detail = call[1];
    return detail !== null && typeof detail === 'object' && 'reason' in detail && detail.reason === reason;
  });
}

beforeEach(() => {
  now = 100_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  request = jest.spyOn(globalThis, 'fetch');
  log = jest.spyOn(logger, 'info');
  wait.mockReset().mockImplementation(async (ms: number, _value?: unknown, options?: { signal?: AbortSignal }) => {
    options?.signal?.throwIfAborted();
    now += ms;
  });
});
afterEach(() => { jest.restoreAllMocks(); });

it('matches Japanese lyrics to the actual romanized YouTube music metadata', async () => {
  request.mockResolvedValueOnce(json(record));
  expect(await new LyricsClient().lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'found', attempt: 1, synchronized: true });
});

it.each([500, 502, 504])('recovers from transient HTTP %s with one spaced retry', async status => {
  request.mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json(record));
  expect(await new LyricsClient().lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(2);
  expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(300);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'http_error', httpStatus: status, attempt: 1, retrying: true });
});

it.each([
  [new TypeError('private-network-detail'), 'network_error'],
  [new DOMException('private-timeout-detail', 'TimeoutError'), 'network_timeout'],
])('recovers once from %s without logging exception contents', async (error, reason) => {
  request.mockRejectedValueOnce(error).mockResolvedValueOnce(json(record));
  expect(await new LyricsClient().lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(2);
  expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(300);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason, attempt: 1, retrying: true });
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
});

it('limits network attempts and does not cache a transient failure as missing lyrics', async () => {
  const failure = new TypeError('private-network-detail');
  request.mockRejectedValue(failure);
  const client = new LyricsClient();
  await expect(client.lookup(track)).rejects.toBe(failure);
  expect(request).toHaveBeenCalledTimes(2);
  request.mockResolvedValueOnce(json(record));
  expect(await client.lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(3);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'network_error', attempt: 2, retrying: false });
});

it.each([429, 503])('honors a short Retry-After and adds jitter before retrying HTTP %s', async status => {
  request.mockResolvedValueOnce(json({}, status, { 'retry-after': '1' })).mockResolvedValueOnce(json(record));
  expect(await new LyricsClient().lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(2);
  expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
  expect(wait.mock.calls[0][0]).toBeLessThan(1100);
});

it.each([429, 503])('retains a long HTTP %s cooldown without retrying or bypassing it', async status => {
  request.mockResolvedValueOnce(json({}, status, { 'retry-after': '60' }));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup({ ...track, title: 'Another Song' })).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'cooldown' });
});

it('uses the documented conservative cooldown when Retry-After is absent', async () => {
  request.mockResolvedValueOnce(json({}, 503));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it('does not retry or cache HTTP 403', async () => {
  request.mockImplementation(async () => json({ private: 'upstream-body-secret' }, 403));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'http_error', httpStatus: 403, attempt: 1, retrying: false });
});

it('caches a legitimate 404 and reports the negative cache hit', async () => {
  request.mockResolvedValueOnce(json({}, 404));
  const client = new LyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'not_found', httpStatus: 404, attempt: 1, retrying: false });
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'cache_hit', found: false });
  now += 5 * 60_000 + 1;
  request.mockResolvedValueOnce(json(record));
  expect(await client.lookup(track)).toEqual(expected);
});

it.each([
  ['invalid_record', { trackName: 123 }],
  ['metadata_mismatch', { ...record, albumName: 'Different Album' }],
  ['instrumental', { ...record, instrumental: true }],
  ['no_lyrics', { ...record, syncedLyrics: null }],
])('reports %s safely, without retrying an unsuitable result', async (reason, value) => {
  request.mockResolvedValueOnce(json(value));
  expect(await new LyricsClient().lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  expect(loggedReason(reason)).toBe(true);
});

it('reports content type, malformed JSON and oversized responses without retries or leaked payloads', async () => {
  for (const [response, reason, rejects] of [
    [new Response('upstream-body-secret', { headers: { 'content-type': 'text/html' } }), 'wrong_content_type', false],
    [new Response('upstream-body-secret', { headers: { 'content-type': 'application/json' } }), 'invalid_json', true],
    [new Response('upstream-body-secret', { headers: { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) } }), 'response_too_large', true],
  ] as const) {
    request.mockClear().mockResolvedValueOnce(response);
    const lookup = new LyricsClient().lookup(track);
    if (rejects) await expect(lookup).rejects.toThrow();
    else expect(await lookup).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(loggedReason(reason)).toBe(true);
  }
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/upstream-body-secret|Sukidakara|Yuika|lrclib|検証/);
});

it('keeps concurrent lookups sequential and spaces separate requests', async () => {
  let active = 0;
  let maximum = 0;
  request.mockImplementation(async url => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return json({ ...record, trackName: new URL(String(url)).searchParams.get('track_name') });
  });
  const client = new LyricsClient();
  const values = await Promise.all([client.lookup(track), client.lookup({ ...track, title: 'Second Song' })]);
  expect(values).toEqual([expected, expected]);
  expect(maximum).toBe(1);
  expect(wait.mock.calls[0][0]).toBeGreaterThanOrEqual(300);
});

it('does not request on cancellation and aborts retry backoff promptly', async () => {
  const before = new AbortController();
  before.abort();
  await expect(new LyricsClient().lookup(track, before.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();

  const controller = new AbortController();
  request.mockRejectedValueOnce(new TypeError('private-network-detail'));
  wait.mockImplementationOnce((_ms: number, _value?: unknown, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  const lookup = new LyricsClient().lookup(track, controller.signal);
  const result = expect(lookup).rejects.toMatchObject({ name: 'AbortError' });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(wait).toHaveBeenCalledTimes(1);
  controller.abort();
  await result;
  expect(request).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'cancelled', attempt: 2 });
});

it('records invalid metadata without making an upstream request', async () => {
  expect(await new LyricsClient().lookup({ ...track, artist: '' })).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('YouTube Music lyrics lookup', { reason: 'invalid_metadata' });
});
