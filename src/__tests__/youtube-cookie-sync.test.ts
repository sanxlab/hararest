import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { HomeCookieSync } from '../modules/youtube/youtube.cookie-sync';

const cookie =
  '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\t__Secure-3PAPISID\tfixture-secret\n';
const rotatedCookie =
  '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\t__Secure-3PAPISID\trotated-secret\n';
const loggedOutCookie =
  '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tVISITOR_INFO1_LIVE\tonly-visitor\n';
const sha256 = (value: string) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');

let directory: string;
let target: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-sync-'));
  target = path.join(directory, 'yt-dlp.txt');
  process.env.HOME_HELPER_URL = 'http://100.112.3.60:20129';
  process.env.HOME_HELPER_TOKEN = 'x'.repeat(43);
});
afterEach(() => {
  delete process.env.HOME_HELPER_URL;
  delete process.env.HOME_HELPER_TOKEN;
  delete process.env.TAILSCALE_AUTHKEY;
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it('writes the helper cookie file privately through the tailnet proxy', async () => {
  const request = jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: cookie, headers: {} });
  process.env.TAILSCALE_AUTHKEY = 'fixture';
  expect(await new HomeCookieSync(target, 0).refresh()).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toBe(cookie);
  expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'GET',
    url: 'http://100.112.3.60:20129/cookies',
    maxRedirects: 0,
    headers: { Authorization: `Bearer ${'x'.repeat(43)}` },
    proxy: { protocol: 'http', host: '127.0.0.1', port: 1056 },
  }));
});

it('reports unchanged cookies so callers do not overwrite local rotations', async () => {
  jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: cookie, headers: {} });
  const sync = new HomeCookieSync(target, 0);
  expect(await sync.refresh()).toBe(true);
  fs.writeFileSync(target, rotatedCookie);
  expect(await sync.refresh()).toBe(false);
  expect(fs.readFileSync(target, 'utf8')).toBe(rotatedCookie);
});

it('rate-limits refreshes and shares an in-flight request', async () => {
  const request = jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: cookie, headers: {} });
  const sync = new HomeCookieSync(target, 60_000);
  const [first, second] = await Promise.all([sync.refresh(), sync.refresh()]);
  expect([first, second]).toEqual([true, true]);
  expect(await sync.refresh()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});

it.each(['<html>login</html>', '# Netscape HTTP Cookie File\nbroken-row\n'])(
  'keeps the previous file when the helper returns invalid data: case %#',
  async (data) => {
    fs.writeFileSync(target, cookie);
    jest.spyOn(axios, 'request').mockResolvedValue({ status: 200, data, headers: {} });
    expect(await new HomeCookieSync(target, 0).refresh()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe(cookie);
  },
);

it('treats helper downtime as a miss and never sends the token off-tailnet', async () => {
  const request = jest.spyOn(axios, 'request').mockRejectedValue(new Error('offline'));
  expect(await new HomeCookieSync(target, 0).refresh()).toBe(false);
  process.env.HOME_HELPER_URL = 'http://example.com:20129';
  request.mockClear();
  expect(await new HomeCookieSync(target, 0).refresh()).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(fs.existsSync(target)).toBe(false);
});

it('does nothing when the helper is not configured', async () => {
  delete process.env.HOME_HELPER_URL;
  const request = jest.spyOn(axios, 'request');
  expect(await new HomeCookieSync(target, 0).refresh()).toBe(false);
  expect(request).not.toHaveBeenCalled();
});

it('pushes yt-dlp rotated cookies back to the home helper with If-Match', async () => {
  const request = jest.spyOn(axios, 'request')
    .mockResolvedValueOnce({ status: 200, data: cookie, headers: {} })
    .mockResolvedValueOnce({ status: 200, data: '{"ok":true}', headers: {} });
  const sync = new HomeCookieSync(target, 0, 10_000);
  await sync.refresh();
  fs.writeFileSync(target, rotatedCookie);
  sync.notifyLocalChange();
  await sync.flush();
  sync.stop();
  expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
    method: 'PUT',
    url: 'http://100.112.3.60:20129/cookies',
    data: Buffer.from(rotatedCookie, 'utf8'),
    headers: expect.objectContaining({
      Authorization: `Bearer ${'x'.repeat(43)}`,
      'Content-Type': 'text/plain; charset=utf-8',
      'If-Match': `"${sha256(cookie)}"`,
    }),
  }));
});

it('never overwrites the home helper with a logged-out cookie jar', async () => {
  const request = jest.spyOn(axios, 'request')
    .mockResolvedValueOnce({ status: 200, data: cookie, headers: {} });
  const sync = new HomeCookieSync(target, 0);
  await sync.refresh();
  fs.writeFileSync(target, loggedOutCookie);
  await sync.push();
  expect(request).toHaveBeenCalledTimes(1);
});

it('adopts a newer home cookie on HTTP 412 instead of overwriting it', async () => {
  const manualCookie =
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\t__Secure-3PAPISID\tmanual-upload\n';
  const request = jest.spyOn(axios, 'request')
    .mockResolvedValueOnce({ status: 200, data: cookie, headers: {} })
    .mockResolvedValueOnce({ status: 412, data: '{"error":"precondition_failed"}', headers: {} })
    .mockResolvedValueOnce({ status: 200, data: manualCookie, headers: {} });
  const sync = new HomeCookieSync(target, 60_000);
  await sync.refresh();
  fs.writeFileSync(target, rotatedCookie);
  await sync.push();
  expect(request).toHaveBeenCalledTimes(3);
  expect(fs.readFileSync(target, 'utf8')).toBe(manualCookie);
});
