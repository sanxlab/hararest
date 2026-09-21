import { AppError } from '../../utils/AppError';

export const REDDIT_HOSTS = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'm.reddit.com',
  'redd.it',
  'www.redd.it',
];
export const MEDIA_HOSTS = [
  'i.redd.it',
  'v.redd.it',
  'preview.redd.it',
  'external-preview.redd.it',
  'i.redditmedia.com',
];

export function redditUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('Invalid Reddit URL.', 400);
  }
  if (!REDDIT_HOSTS.includes(url.hostname))
    throw new AppError('Only Reddit URLs are allowed.', 403);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new AppError('Invalid Reddit URL protocol, credentials, or port.', 400);
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url;
}

export function postId(url: URL): string | null {
  if (/^(?:www\.)?redd\.it$/.test(url.hostname))
    return /^\/([a-z0-9]+)\/?$/i.exec(url.pathname)?.[1] ?? null;
  return (
    /^\/(?:r\/[^/]+\/|(?:user|u)\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i.exec(
      url.pathname,
    )?.[1] ??
    /^\/gallery\/([a-z0-9]+)\/?$/i.exec(url.pathname)?.[1] ??
    null
  );
}

export function isShareLink(url: URL): boolean {
  return /^\/(?:r\/[^/]+\/)?s\/[a-z0-9]+\/?$/i.test(url.pathname);
}

// Restrict both returned media and fetched manifests to Reddit's own CDNs.
export function mediaUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.replace(/&amp;/g, '&'), base);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !MEDIA_HOSTS.includes(url.hostname)
    )
      return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}
