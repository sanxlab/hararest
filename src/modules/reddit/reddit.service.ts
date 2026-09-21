import axios from 'axios';
import { z } from 'zod';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { RedditDownloadResult } from './reddit.types';
import { isShareLink, MEDIA_HOSTS, postId, REDDIT_HOSTS, redditUrl } from './reddit.urls';
import { parseRedditPost } from './reddit.parser';
import { parseRedditDash } from './reddit.dash';

const requestOptions = {
  timeout: 15000,
  maxRedirects: 0,
  maxContentLength: 5 * 1024 * 1024,
  proxy: false as const,
  httpAgent: publicHttpAgent,
  httpsAgent: publicHttpsAgent,
  validateStatus: () => true,
};
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

interface RedditOptions {
  clientId?: string;
  clientSecret?: string;
  userAgent?: string;
}
export class RedditService {
  private readonly options: RedditOptions;
  private token: { value: string; until: number } | null = null;
  private pendingToken?: Promise<string>;
  constructor(
    options: RedditOptions = {
      clientId: process.env.REDDIT_CLIENT_ID?.trim(),
      clientSecret: process.env.REDDIT_CLIENT_SECRET?.trim(),
      userAgent: process.env.REDDIT_USER_AGENT?.trim(),
    },
  ) {
    this.options = options;
  }

  private get userAgent() {
    return this.options.userAgent || 'Hararest/1.0 (Reddit media downloader)';
  }

  private async accessToken(): Promise<string> {
    if (!this.options.clientId && !this.options.clientSecret) return '';
    if (!this.options.clientId || !this.options.clientSecret)
      throw new AppError('Configure both REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.', 503);
    if (this.token && this.token.until > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = (async () => {
      try {
        const response = await axios.post(
          'https://www.reddit.com/api/v1/access_token',
          'grant_type=client_credentials',
          {
            ...requestOptions,
            auth: { username: this.options.clientId!, password: this.options.clientSecret! },
            headers: {
              'User-Agent': this.userAgent,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
        );
        const result = tokenSchema.safeParse(response.data);
        if (response.status !== 200 || !result.success) throw new Error('Invalid token');
        this.token = {
          value: result.data.access_token,
          until: Date.now() + Math.max(0, result.data.expires_in - 60) * 1000,
        };
        return this.token.value;
      } catch {
        throw new AppError(
          'Reddit authentication failed. Check the configured API credentials and app access.',
          503,
        );
      }
    })();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = undefined;
    }
  }

  private async resolve(input: URL): Promise<URL> {
    let target = input;
    for (let hop = 0; hop <= 5; hop++) {
      const id = postId(target);
      if (id) {
        if (/^(?:www\.)?redd\.it$/.test(target.hostname))
          return new URL(`https://www.reddit.com/comments/${id}/`);
        target.hostname = 'www.reddit.com';
        return target;
      }
      if (!isShareLink(target)) throw new AppError('Use a Reddit post or share URL.', 400);
      await assertPublicUrl(target.href, REDDIT_HOSTS);
      let response;
      try {
        response = await axios.get(target.href, {
          ...requestOptions,
          maxContentLength: 1024 * 1024,
          headers: { 'User-Agent': this.userAgent },
        });
      } catch {
        throw new AppError('Unable to resolve the Reddit share URL. Try the full post URL.', 502);
      }
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        typeof response.headers.location !== 'string'
      )
        throw new AppError('Reddit did not resolve the share URL. Try the full post URL.', 502);
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

  private async fetchPost(id: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken();
      let response;
      try {
        response = await axios.get(
          `https://${token ? 'oauth' : 'www'}.reddit.com/comments/${id}.json`,
          {
            ...requestOptions,
            params: { raw_json: 1, limit: 1, depth: 1 },
            headers: {
              'User-Agent': this.userAgent,
              Accept: 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          },
        );
      } catch {
        throw new AppError('Unable to contact Reddit. Try again later.', 502);
      }
      if (response.status === 401 && token && attempt === 0) {
        this.token = null;
        continue;
      }
      if (response.status === 404)
        throw new AppError('Reddit post was not found or has been removed.', 404);
      if (response.status === 429)
        throw new AppError('Reddit rate limit reached. Try again later.', 503);
      if ([401, 403].includes(response.status))
        throw new AppError(
          token
            ? 'Reddit denied access to this post or API app.'
            : 'Reddit blocked anonymous API access. Configure REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET on Hararest, or try again later.',
          503,
        );
      if (response.status !== 200)
        throw new AppError('Reddit returned an unexpected response.', 502);
      return response.data;
    }
    throw new AppError('Reddit authentication failed.', 503);
  }

  async download(input: string): Promise<RedditDownloadResult> {
    const source = redditUrl(input);
    const sourceURL = source.href;
    const resolved = await this.resolve(source);
    const data = parseRedditPost(await this.fetchPost(postId(resolved)!), postId(resolved)!);
    if (data.dash) {
      try {
        await assertPublicUrl(data.dash, MEDIA_HOSTS);
        const response = await axios.get<string>(data.dash, {
          ...requestOptions,
          maxContentLength: 1024 * 1024,
          responseType: 'text',
          headers: { 'User-Agent': this.userAgent },
        });
        if (response.status === 200 && typeof response.data === 'string') {
          const tracks = parseRedditDash(response.data, data.dash, data.media[0]?.is_gif === true);
          if (tracks.length) data.media = tracks;
        }
      } catch {
        /* Preserve the direct fallback video, explicitly marked without audio. */
      }
    }
    if (!data.media.length)
      throw new AppError('No supported Reddit-hosted media found in this post.', 404);
    return {
      source_url: sourceURL,
      resolved_url: resolved.href,
      provider: 'reddit',
      is_gallery: data.gallery,
      title: data.title,
      uploader: data.uploader,
      thumbnail: data.thumbnail,
      duration: data.duration,
      download_url: data.media[0].url,
      requires_conversion: false,
      count: data.media.length,
      media: data.media,
    };
  }
}
