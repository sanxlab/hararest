import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import dns from 'node:dns/promises';

function isSafeIP(ip: string): boolean {
  // IPv4 regexes
  const loopbackIPv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const linkLocalIPv4 = /^169\.254\.\d{1,3}\.\d{1,3}$/;
  const private10 = /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const private172 = /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/;
  const private192 = /^192\.168\.\d{1,3}\.\d{1,3}$/;
  
  // IPv6 regexes
  const loopbackIPv6 = /^::1$/;
  const uniqueLocalIPv6 = /^f[c-d][0-9a-f]{2}:/i;
  const linkLocalIPv6 = /^fe80:/i;
  const mappedLoopback = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i;
  const mappedLinkLocal = /^::ffff:169\.254\.\d{1,3}\.\d{1,3}$/i;
  const mappedPrivate10 = /^::ffff:10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i;
  const mappedPrivate172 = /^::ffff:172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/i;
  const mappedPrivate192 = /^::ffff:192\.168\.\d{1,3}\.\d{1,3}$/i;

  if (
    loopbackIPv4.test(ip) || linkLocalIPv4.test(ip) || private10.test(ip) ||
    private172.test(ip) || private192.test(ip) || loopbackIPv6.test(ip) ||
    uniqueLocalIPv6.test(ip) || linkLocalIPv6.test(ip) || mappedLoopback.test(ip) ||
    mappedLinkLocal.test(ip) || mappedPrivate10.test(ip) || mappedPrivate172.test(ip) ||
    mappedPrivate192.test(ip) || ip === '0.0.0.0' || ip === '::'
  ) {
    return false;
  }
  return true;
}

export const ssrfProtect = (allowedHosts: string[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return next();
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return next(new AppError('Invalid URL format', 400));
      }

      // 1. Validate Protocol
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return next(new AppError('Invalid URL protocol. Only HTTP and HTTPS are allowed.', 400));
      }

      // 2. Validate Domain Allowlist
      const hostname = parsedUrl.hostname.toLowerCase();
      if (allowedHosts && allowedHosts.length > 0) {
        const isAllowed = allowedHosts.some(host => {
          return hostname === host || hostname.endsWith(`.${host}`);
        });
        if (!isAllowed) {
          return next(new AppError(`Domain ${hostname} is not allowed.`, 403));
        }
      }

      // 3. DNS Lookup & IP Validation (Basic SSRF prevention)
      try {
        const lookupResult = await dns.lookup(hostname);
        if (!isSafeIP(lookupResult.address)) {
          return next(new AppError('Target URL resolves to a private or restricted IP address.', 403));
        }
      } catch {
        return next(new AppError(`DNS resolution failed for domain: ${hostname}`, 400));
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
