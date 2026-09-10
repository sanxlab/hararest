import { publicHttpAgent, publicHttpsAgent } from './publicAgent';
import fetch from 'node-fetch';
import { assertPublicUrl } from '../middlewares/ssrf.middleware';

export async function getMediaSize(url: string): Promise<number> {
  try {
    await assertPublicUrl(url);
    const response = await fetch(url, { method: 'HEAD', redirect: 'error', timeout: 10000, agent: (parsed) => parsed.protocol === 'https:' ? publicHttpsAgent : publicHttpAgent });
    if (!response.ok) return 0;
    const value = response.headers.get('content-length');
    if (!value || !/^\d+$/.test(value)) return 0;
    const size = Number(value);
    return Number.isSafeInteger(size) && size >= 0 ? size : 0;
  } catch {
    return 0;
  }
}

export function bytesToSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}
