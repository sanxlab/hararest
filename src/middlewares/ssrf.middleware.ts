import { Request, Response, NextFunction } from 'express';
import * as dns from 'dns/promises';
import { BlockList, isIP } from 'node:net';
import { AppError } from '../utils/AppError';

const restrictedIPs = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  restrictedIPs.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const) {
  restrictedIPs.addSubnet(network, prefix, 'ipv6');
}

export function isSafeIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) {
    return false;
  }

  return !restrictedIPs.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export async function assertPublicUrl(url: string, allowedHosts?: readonly string[]): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new AppError('Invalid URL format', 400);
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new AppError('Invalid URL protocol. Only HTTP and HTTPS are allowed.', 400);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
    throw new AppError('URL credentials and non-standard ports are not allowed.', 400);
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (allowedHosts && !allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    throw new AppError(`Domain ${hostname} is not allowed.`, 403);
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true });
  } catch {
    throw new AppError(`DNS resolution failed for domain: ${hostname}`, 400);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isSafeIP(address))) {
    throw new AppError('Target URL resolves to a private or restricted IP address.', 403);
  }
  return parsedUrl;
}

export const ssrfProtect = (allowedHosts: readonly string[]) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const url = req.query.url;
      if (url === undefined) return next();
      if (typeof url !== 'string' || !url.trim()) {
        throw new AppError('URL must be a non-empty string.', 400);
      }
      await assertPublicUrl(url, allowedHosts);
      next();
    } catch (error) {
      next(error);
    }
  };
};
