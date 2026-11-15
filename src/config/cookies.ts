import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MAX_COOKIE_FILE_BYTES = 48 * 1024;

// True only for a Netscape cookie export with complete, tab-separated rows.
export function isNetscapeCookieFile(bytes: Buffer): boolean {
  if (bytes.length === 0 || bytes.length > MAX_COOKIE_FILE_BYTES) return false;
  const contents = bytes.toString('utf8');
  if (
    Buffer.from(contents, 'utf8').length !== bytes.length ||
    contents.includes('\0') ||
    !/^# (?:Netscape )?HTTP Cookie File(?:\r?\n|$)/.test(contents)
  )
    return false;
  const rows = contents
    .split(/\r?\n/)
    .filter((line) => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  return rows.length > 0 && rows.every((line) => line.split('\t').length === 7);
}

// True when the jar still holds an unexpired YouTube login cookie. A jar that
// YouTube logged out must never overwrite the good copy on the home server.
export function hasYoutubeLogin(bytes: Buffer, now = Date.now()): boolean {
  return bytes.toString('utf8').split(/\r?\n/).some((line) => {
    if (line.startsWith('#') && !line.startsWith('#HttpOnly_')) return false;
    const fields = line.replace(/^#HttpOnly_/, '').split('\t');
    if (fields.length !== 7) return false;
    const [domain, , , , expires, name, value] = fields;
    const expiry = Number(expires);
    return /(?:^|\.)youtube\.com$/.test(domain) && name === '__Secure-3PAPISID' && !!value &&
      Number.isFinite(expiry) && (expiry === 0 || expiry * 1000 > now);
  });
}

// Private directory for a cookie file that is (re)written at runtime.
export function privateCookiePath(): string {
  try {
    return path.join(mkdtempSync(path.join(tmpdir(), 'hararest-cookies-')), 'yt-dlp.txt');
  } catch {
    throw new Error('Unable to prepare the runtime YouTube cookie file.');
  }
}

// Restore a private, writable cookie jar on every boot. Never include cookie
// content in errors, logs, build arguments, or the container image.
export function restoreCookieFile(encoded: string | undefined): string | undefined {
  if (!encoded?.trim()) return undefined;
  const value = encoded.replace(/\s/g, '');
  const invalid = () =>
    new Error('YTDLP_COOKIES_BASE64 must contain a base64-encoded Netscape cookie file.');
  if (
    value.length > 65536 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw invalid();
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || !isNetscapeCookieFile(bytes)) throw invalid();

  const filename = privateCookiePath();
  try {
    writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
    return filename;
  } catch {
    rmSync(path.dirname(filename), { recursive: true, force: true });
    throw new Error('Unable to prepare the runtime YouTube cookie file.');
  }
}
