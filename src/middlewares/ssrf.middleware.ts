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

function isSafeIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) {
    return false;
  }

  return !restrictedIPs.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export const ssrfProtect = (allowedHosts: readonly string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = req.query.url as string | undefined;
      if (!url) {
        return next();
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return next(new AppError('Invalid URL format', 400));
      }

      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return next(new AppError('Invalid URL protocol. Only HTTP and HTTPS are allowed.', 400));
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      const isAllowed = allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
      if (!isAllowed) {
        return next(new AppError(`Domain ${hostname} is not allowed.`, 403));
      }

      try {
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        if (addresses.length === 0 || addresses.some(({ address }) => !isSafeIP(address))) {
          return next(new AppError('Target URL resolves to a private or restricted IP address.', 403));
        }
      } catch {
        return next(new AppError(`DNS resolution failed for domain: ${hostname}`, 400));
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
};
