import fs from 'node:fs';
import path from 'node:path';
import { restoreCookieFile } from '../config/cookies';

const cookie =
  '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tfixture-secret\n';
const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0))
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

it('restores exact cookie bytes privately on every boot', () => {
  for (let boot = 0; boot < 2; boot++) {
    const file = restoreCookieFile(Buffer.from(cookie).toString('base64'))!;
    files.push(file);
    expect(fs.readFileSync(file, 'utf8')).toBe(cookie);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  }
  expect(files[0]).not.toBe(files[1]);
});

it.each([undefined, '', '  '])(
  'leaves file-based configuration available when secret is absent: %s',
  (value) => {
    expect(restoreCookieFile(value)).toBeUndefined();
  },
);

it('accepts wrapped base64 and CRLF cookie exports', () => {
  const contents = cookie.replace(/\n/g, '\r\n');
  const encoded = Buffer.from(contents)
    .toString('base64')
    .replace(/(.{60})/g, '$1\n');
  const file = restoreCookieFile(encoded)!;
  files.push(file);
  expect(fs.readFileSync(file, 'utf8')).toBe(contents);
});

it.each([
  'fixture-secret!',
  Buffer.from('fixture-secret').toString('base64'),
  Buffer.from('# Netscape HTTP Cookie File\n').toString('base64'),
  Buffer.from('# Netscape HTTP Cookie File\nfixture-secret\n').toString('base64'),
  Buffer.from(cookie + '\0').toString('base64'),
  'A'.repeat(65540),
])('rejects malformed secrets without exposing their contents: case %#', (encoded) => {
  expect(() => restoreCookieFile(encoded)).toThrow(
    'YTDLP_COOKIES_BASE64 must contain a base64-encoded Netscape cookie file.',
  );
});
