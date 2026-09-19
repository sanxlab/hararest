import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import axios from 'axios';
import { z } from 'zod';
import { assertPublicUrl, isSafeIP } from '../../middlewares/ssrf.middleware';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { RedditDownloadResult, RedditMedia } from './reddit.types';

const PROVIDER_API = 'https://api-wh.savefrom.co.id/api/convert';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const REDDIT_HOSTS = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'm.reddit.com',
  'redd.it',
  'www.redd.it',
];
// Public signing parameters from SaveFrom's link.chunk.js, verified 2026-09-19.
// Reproduce the client protocol without executing third-party JavaScript on the server.
const CLIENT_TIMESTAMP = '1789035341806';
const CLIENT_SALT = 'eba973918a4d6d2457bf8d3cf8d17987e15d238e07e7cff83d0f0937226fe277';

function redditUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('Invalid Reddit URL.', 400);
  }
  if (!REDDIT_HOSTS.includes(url.hostname))
    throw new AppError('Only Reddit URLs are allowed.', 403);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new AppError('Invalid Reddit URL protocol, credentials, or port.', 400);
  }
  url.protocol = 'https:';
  url.search = '';
  url.hash = '';
  return url;
}

function isPost(url: URL): boolean {
  return (
    (url.hostname.endsWith('reddit.com') &&
      /^\/(?:r\/[^/]+\/|(?:user|u)\/[^/]+\/)?comments\/[a-z0-9]+(?:\/|$)/i.test(url.pathname)) ||
    (url.hostname.endsWith('reddit.com') && /^\/gallery\/[a-z0-9]+\/?$/i.test(url.pathname))
  );
}

function isShortLink(url: URL): boolean {
  return (
    (/^(?:www\.)?redd\.it$/.test(url.hostname) && /^\/[a-z0-9]+\/?$/i.test(url.pathname)) ||
    /^\/(?:r\/[^/]+\/)?s\/[a-z0-9]+\/?$/i.test(url.pathname)
  );
}

// URLs are returned to clients, not fetched. Reject dangerous schemes and local targets.
function mediaUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      !host.includes('.') ||
      (isIP(host) && !isSafeIP(host))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const resultSchema = z.object({
  url: z.array(
    z.object({
      url: z.string(),
      type: z.string().optional(),
      ext: z.string().optional(),
      quality: z.union([z.string(), z.number()]).optional(),
      subname: z.string().optional(),
      qualityNumber: z.number().nonnegative().optional(),
      isConverterUI: z.boolean().optional(),
      no_audio: z.boolean().optional(),
    }),
  ),
  meta: z
    .object({
      title: z.string().optional(),
      uploader: z.string().optional(),
      duration: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  thumb: z.string().nullish(),
});

export class RedditService {
  private async resolve(input: URL): Promise<string> {
    let target = input;
    for (let hop = 0; hop <= 5; hop++) {
      if (isPost(target)) {
        target.hostname = 'www.reddit.com';
        return target.href;
      }
      if (!isShortLink(target)) throw new AppError('Use a Reddit post or share URL.', 400);
      await assertPublicUrl(target.href, REDDIT_HOSTS);
      let response;
      try {
        response = await axios.get<string>(target.href, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: 10000,
          maxRedirects: 0,
          maxContentLength: 1024 * 1024,
          proxy: false,
          httpAgent: publicHttpAgent,
          httpsAgent: publicHttpsAgent,
          validateStatus: () => true,
        });
      } catch {
        throw new AppError('Unable to resolve the Reddit share URL.', 502);
      }
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        typeof response.headers.location !== 'string'
      ) {
        throw new AppError('Reddit did not resolve the share URL. Try the full post URL.', 502);
      }
      let redirect: URL;
      try {
        redirect = new URL(response.headers.location, target);
      } catch {
        throw new AppError('Reddit returned an invalid redirect.', 502);
      }
      target = redditUrl(redirect.href);
    }
    throw new AppError('Too many Reddit redirects.', 502);
  }

  async download(input: string): Promise<RedditDownloadResult> {
    const source = redditUrl(input);
    const resolved = await this.resolve(source);
    const timestamp = String(Date.now());
    const form = new URLSearchParams({
      sf_url: resolved,
      ts: timestamp,
      _ts: CLIENT_TIMESTAMP,
      _tsc: '0',
      _s: createHash('sha256')
        .update(resolved + timestamp + CLIENT_SALT)
        .digest('hex'),
    });
    let body: unknown;
    try {
      const response = await axios.post<unknown>(PROVIDER_API, form.toString(), {
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://savefrom.co.id',
          Referer: 'https://savefrom.co.id/reddit-video-downloader',
          Accept: 'application/json',
        },
        timeout: 20000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        proxy: false,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent,
      });
      body = response.data;
    } catch {
      throw new AppError('Reddit downloader provider is unavailable. Try again later.', 502);
    }
    const failure = z
      .object({ success: z.literal(false), response: z.number().optional() })
      .safeParse(body);
    if (failure.success) {
      if (failure.data.response === 4)
        throw new AppError('No downloadable media found in this Reddit post.', 404);
      throw new AppError('Reddit downloader provider rejected the request.', 502);
    }
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success)
      throw new AppError('Invalid response from the Reddit downloader provider.', 502);
    const media: RedditMedia[] = [];
    const seen = new Set<string>();
    for (const item of parsed.data.url) {
      const url = mediaUrl(item.url);
      if (!url || seen.has(url)) continue;
      const format = (item.ext || item.type || '').toLowerCase();
      const type = ['mp4', 'webm', 'mov'].includes(format)
        ? 'video'
        : ['mp3', 'm4a', 'aac', 'ogg'].includes(format)
          ? 'audio'
          : ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(format)
            ? 'image'
            : null;
      if (!type) continue;
      seen.add(url);
      media.push({
        url,
        type,
        format,
        quality: String(item.quality || item.subname || ''),
        quality_number: item.qualityNumber || 0,
        requires_conversion: item.isConverterUI === true,
        has_audio:
          type === 'image'
            ? false
            : type === 'audio'
              ? true
              : item.no_audio === undefined
                ? null
                : !item.no_audio,
      });
    }
    if (!media.length) throw new AppError('No downloadable media found in this Reddit post.', 404);
    media.sort((a, b) => b.quality_number - a.quality_number);
    const duration = Number(parsed.data.meta?.duration);
    return {
      source_url: source.href,
      resolved_url: resolved,
      provider: 'savefrom.co.id',
      title: parsed.data.meta?.title || '',
      uploader: parsed.data.meta?.uploader || '',
      thumbnail: mediaUrl(parsed.data.thumb || undefined),
      duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
      download_url: media[0].url,
      requires_conversion: media[0].requires_conversion,
      count: media.length,
      media,
    };
  }
}
