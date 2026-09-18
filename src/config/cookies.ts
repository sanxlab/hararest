import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  const contents = bytes.toString('utf8');
  if (
    bytes.toString('base64') !== value ||
    contents.includes('\0') ||
    !/^# (?:Netscape )?HTTP Cookie File(?:\r?\n|$)/.test(contents)
  )
    throw invalid();
  const rows = contents
    .split(/\r?\n/)
    .filter((line) => line.trim() && (!line.startsWith('#') || line.startsWith('#HttpOnly_')));
  if (!rows.length || rows.some((line) => line.split('\t').length !== 7)) throw invalid();

  let directory: string | undefined;
  try {
    directory = mkdtempSync(path.join(tmpdir(), 'hararest-cookies-'));
    const filename = path.join(directory, 'yt-dlp.txt');
    writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
    return filename;
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw new Error('Unable to prepare the runtime YouTube cookie file.');
  }
}
