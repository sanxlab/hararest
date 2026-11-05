import axios from 'axios';
import { KugouLyricsClient } from '../modules/youtube/youtube.kugou-lyrics';
import logger from '../utils/logger';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
const request = axios.get as jest.Mock;
const track = { title: 'Fixture Tune', artist: 'Fixture Singer', album: 'Fixture Release', duration: 154.9 };
const candidate = { id: '12345', accesskey: 'fixtureKey123', song: track.title, singer: track.artist, duration: 154958 };
// Original synthetic fixtures, never text copied from a song or provider.
const lrc = '[ti:Fixture Tune]\r\n[offset:0]\r\n[00:04.125]Another original line\r\n[00:01.20]検証用の架空の行';
const expected = {
  text: '[00:01.200]検証用の架空の行\n[00:04.125]Another original line',
  synchronized: [{ timeMs: 1200, text: '検証用の架空の行' }, { timeMs: 4125, text: 'Another original line' }],
};
const response = (value: unknown) => ({ data: Buffer.from(JSON.stringify(value)) });
const encoded = (text: string) => Buffer.from(text).toString('base64');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function respond(content = encoded(lrc), candidates: unknown[] = [candidate]) {
  request.mockResolvedValueOnce(response({ status: 200, candidates }));
  request.mockResolvedValueOnce(response({ status: 200, content }));
}

beforeEach(() => { request.mockReset(); });
afterEach(() => { jest.restoreAllMocks(); });

it('matches the exact recording and preserves/sorts real multilingual millisecond timings', async () => {
  respond();
  expect(await new KugouLyricsClient().lookup(track)).toEqual(expected);
  const search = new URL(request.mock.calls[0][0]);
  expect(search.origin + search.pathname).toBe('https://lyrics.kugou.com/search');
  expect(search.searchParams.get('keyword')).toBe('Fixture Singer - Fixture Tune');
  expect(search.searchParams.get('duration')).toBe('154900');
  const download = new URL(request.mock.calls[1][0]);
  expect(download.origin + download.pathname).toBe('https://lyrics.kugou.com/download');
  expect(Object.fromEntries(download.searchParams)).toMatchObject({ id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', charset: 'utf8' });
  expect(request).toHaveBeenCalledTimes(2);
  for (const call of request.mock.calls) expect(call[1]).toMatchObject({
    responseType: 'arraybuffer', timeout: 5000, maxRedirects: 0, proxy: false,
    maxContentLength: 256 * 1024, maxBodyLength: 256 * 1024,
  });
});

it('normalizes metadata consistently and encodes the fixed-origin search parameters', async () => {
  respond(encoded(lrc), [{ ...candidate, song: '検証 & Tune+', singer: 'Fixture Singer' }]);
  expect(await new KugouLyricsClient().lookup({ ...track, title: '検証 & Tune+', artist: 'Ｆｉｘｔｕｒｅ Singer - Topic' })).toEqual(expected);
  const url = new URL(request.mock.calls[0][0]);
  expect(url.searchParams.get('keyword')).toBe('Ｆｉｘｔｕｒｅ Singer - 検証 & Tune+');
  expect([...url.searchParams.keys()]).toEqual(['ver', 'man', 'client', 'keyword', 'duration']);
});

it.each([
  { ...candidate, song: 'Another Tune' },
  { ...candidate, singer: 'Another Singer' },
  { ...candidate, duration: 157001 },
])('never downloads mismatched title, artist, or duration: %j', async value => {
  request.mockResolvedValueOnce(response({ candidates: [value] }));
  expect(await new KugouLyricsClient().lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('caps candidates at ten and does not follow an eleventh matching candidate', async () => {
  request.mockResolvedValueOnce(response({ candidates: [...Array.from({ length: 10 }, () => ({ ...candidate, song: 'Another Tune' })), candidate] }));
  expect(await new KugouLyricsClient().lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('caps untimed matching downloads at three and caches the valid miss', async () => {
  request.mockResolvedValueOnce(response({ candidates: Array.from({ length: 10 }, (_, i) => ({ ...candidate, id: String(i + 1) })) }));
  request.mockResolvedValue(response({ content: encoded('Original plain fixture') }));
  const client = new KugouLyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(4);
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  { ...candidate, id: 'https://private.test/' },
  { ...candidate, accesskey: '' },
  { ...candidate, duration: '154958' },
])('never downloads malformed candidate credentials or metadata: %j', async value => {
  request.mockResolvedValueOnce(response({ candidates: [value] }));
  expect(await new KugouLyricsClient().lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
});

it('supports multiple source stamps, zero offset, enhanced text and a trailing blank', async () => {
  respond(encoded('[offset:+0]\n[00:01.20][00:04.125]<00:01.20>Original fixture\n[02:36.900]'));
  const value = await new KugouLyricsClient().lookup(track);
  expect(value?.synchronized).toEqual([
    { timeMs: 1200, text: 'Original fixture' }, { timeMs: 4125, text: 'Original fixture' }, { timeMs: 156900, text: '' },
  ]);
});

it.each([
  '', 'Original plain fixture', '[00:00]Original first\n[00:00.000]Original second',
  '[00:01]Only one original timed line\n[00:02]',
])('rejects empty, plain, all-zero, or insufficient real timings: %s', async text => {
  respond(encoded(text));
  expect(await new KugouLyricsClient().lookup(track)).toBeUndefined();
});

it.each([
  '!!!!', encoded(lrc).replace(/=+$/, '') + '!', Buffer.from([0xff, 0xfe, 0xff]).toString('base64'),
  encoded('[00:01]Original\0first\n[00:02]Original second'),
  encoded('[offset:10]\n' + lrc), encoded('[offset:bad]\n' + lrc),
  encoded('[00:61]Original first\n[00:02]Original second'),
  encoded('[-00:01]Original first\n[00:02]Original second'),
  encoded('[00:01.2000]Original first\n[00:02]Original second'),
  encoded('[02:36.901]Original first\n[00:02]Original second'),
  encoded('[00:01]Original first\nuntimed original line\n[00:02]Original second'),
  encoded('x'.repeat(64 * 1024 + 1)),
  encoded(Array.from({ length: 4001 }, () => '[00:01]x').join('\n')),
  encoded('[00:01][00:02]' + '界'.repeat(11_000)),
  encoded(Array.from({ length: 4000 }, (_, i) => `[0:0${i % 2}]12345`).join('\n')),
])('rejects malformed or oversized lyrics without caching the failure', async content => {
  respond(content);
  const client = new KugouLyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  respond();
  expect(await client.lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  Buffer.from('not JSON'), Buffer.from('x'.repeat(256 * 1024 + 1)),
  Buffer.from(JSON.stringify({ status: 500, candidates: [] })),
])('rejects malformed or oversized HTTP data without caching it', async data => {
  request.mockResolvedValueOnce({ data });
  const client = new KugouLyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  respond();
  expect(await client.lookup(track)).toEqual(expected);
});

it('fails softly on an outage, retries on the next lookup, and logs no upstream details', async () => {
  const log = jest.spyOn(logger, 'info');
  request.mockRejectedValueOnce(new Error('https://private.test?accesskey=secret Fixture Tune private lyrics'));
  const client = new KugouLyricsClient();
  expect(await client.lookup(track)).toBeUndefined();
  respond();
  expect(await client.lookup(track)).toEqual(expected);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|accesskey|12345|Fixture|検証/);
});

it('caches success for six hours and valid misses for five minutes', async () => {
  let now = 100_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  const client = new KugouLyricsClient();
  respond();
  expect(await client.lookup(track)).toEqual(expected);
  expect(await client.lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(2);
  now += 6 * 60 * 60_000 + 1;
  request.mockResolvedValueOnce(response({ candidates: [] }));
  expect(await client.lookup(track)).toBeUndefined();
  expect(await client.lookup(track)).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(3);
  now += 5 * 60_000 + 1;
  respond();
  expect(await client.lookup(track)).toEqual(expected);
  expect(request).toHaveBeenCalledTimes(5);
});

it('bounds its cache to 128 recordings', async () => {
  request.mockResolvedValue(response({ candidates: [] }));
  const client = new KugouLyricsClient();
  for (let i = 0; i < 129; i++) await client.lookup({ ...track, title: `Fixture ${i}` });
  await client.lookup({ ...track, title: 'Fixture 0' });
  expect(request).toHaveBeenCalledTimes(130);
});

it('coalesces queued identical lookups and bounds pending work to sixteen', async () => {
  const resolve: Array<(value: unknown) => void> = [];
  request.mockImplementation(() => new Promise(value => resolve.push(value)));
  const client = new KugouLyricsClient();
  const first = client.lookup(track);
  const duplicate = client.lookup(track);
  const others = Array.from({ length: 14 }, (_, i) => client.lookup({ ...track, title: `Another fixture ${i}` }));
  expect(await client.lookup({ ...track, title: 'Excess fixture' })).toBeUndefined();
  await tick();
  expect(request).toHaveBeenCalledTimes(1);
  resolve[0](response({ candidates: [] }));
  await first;
  await duplicate;
  for (let i = 1; i <= 14; i++) {
    await tick();
    expect(request).toHaveBeenCalledTimes(i + 1);
    resolve[i](response({ candidates: [] }));
  }
  await Promise.all(others);
});

it('propagates cancellation before and during HTTP requests without caching it', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new KugouLyricsClient();
  await expect(client.lookup(track, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
  const active = new AbortController();
  request.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private cancellation')));
  }));
  const pending = client.lookup(track, active.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await tick();
  expect(request.mock.calls[0][1].signal).toBe(active.signal);
  active.abort();
  await cancelled;
  respond();
  expect(await client.lookup(track)).toEqual(expected);
});

it.each([0, -1, NaN, Infinity, 3601])('skips invalid metadata duration %s', async duration => {
  expect(await new KugouLyricsClient().lookup({ ...track, duration })).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});
