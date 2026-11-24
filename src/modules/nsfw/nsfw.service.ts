import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import axios from 'axios';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';

const DEFAULT_RULE34_API_URL = 'https://api.rule34.xxx';

export class NsfwService {
  private buildRule34Url(tags: string, limit: number, pid?: number): string {
    const normalizedTags = tags.trim();
    if (!normalizedTags) {
      throw new AppError('Query parameter "tags" is required.', 400);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AppError('Parameter "limit" must be an integer between 1 and 1000.', 400);
    }
    if (pid !== undefined && (!Number.isInteger(pid) || pid < 0 || pid > 1000)) {
      throw new AppError('Parameter "pid" must be an integer between 0 and 1000.', 400);
    }

    const userId = process.env.RULE34_USER_ID?.trim() || '';
    const apiKey = process.env.RULE34_API_KEY?.trim() || '';
    if (!userId || !apiKey) {
      throw new AppError('RULE34_USER_ID and RULE34_API_KEY are not configured.', 500);
    }

    const rawBaseUrl = process.env.RULE34_API_URL?.trim() || DEFAULT_RULE34_API_URL;
    let url: URL;
    try {
      url = new URL(rawBaseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('Invalid Rule34 base URL');
      }
    } catch {
      throw new AppError('RULE34_API_URL is invalid.', 500);
    }

    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = basePath.endsWith('/index.php') ? basePath : `${basePath}/index.php`;
    url.searchParams.set('page', 'dapi');
    url.searchParams.set('s', 'post');
    url.searchParams.set('q', 'index');
    url.searchParams.set('json', '1');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('tags', normalizedTags);
    if (pid !== undefined) {
      url.searchParams.set('pid', String(pid));
    }
    url.searchParams.set('user_id', userId);
    url.searchParams.set('api_key', apiKey);
    return url.toString();
  }

  private async fetchJson(
    url: string,
    source: string,
    options: { allowEmptyArray?: boolean } = {},
  ): Promise<unknown> {
    try {
      const response = await axios.get<string>(url, {
        adapter: 'http',
        responseType: 'text',
        transformResponse: [(body: string) => body],
        timeout: 15000,
        maxContentLength: 5 * 1024 * 1024,
        maxRedirects: 0,
        proxy: false,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });
      if (options.allowEmptyArray && typeof response.data === 'string' && response.data.trim() === '') {
        return [];
      }
      let body: unknown;
      let validJson = true;
      try {
        body = JSON.parse(response.data) as unknown;
      } catch {
        body = response.data;
        validJson = false;
      }
      if (typeof body === 'string') {
        if (
          /<html|<!doctype|Just a moment|Missing authentication|Cloudflare|Enable JavaScript/i.test(
            body,
          )
        ) {
          throw new AppError(`${source} menolak akses atau mengembalikan halaman verifikasi.`, 502);
        }
        if (body.includes('Use new API')) {
          throw new AppError(`${source} API telah usang atau berubah.`, 502);
        }
      }
      if (!validJson) {
        throw new AppError(
          `${source} mengembalikan respons JSON tidak valid atau halaman verifikasi.`,
          502,
        );
      }
      return body;
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && [403, 503].includes(error.response?.status ?? 0)) {
        throw new AppError(
          `${source} menolak akses atau sedang tidak tersedia (HTTP ${error.response?.status}).`,
          502,
        );
      }
      if (error instanceof AppError) throw error;
      logger.error(`${source} request failed`);
      throw new AppError(`Gagal mengambil data dari ${source}.`, 502);
    }
  }

  public async getRule34(tags: string, limit: number, pid?: number): Promise<unknown[]> {
    const url = this.buildRule34Url(tags, limit, pid);
    const data = await this.fetchJson(url, 'Rule34', { allowEmptyArray: true });
    if (!Array.isArray(data)) {
      throw new AppError('Rule34 mengembalikan respons yang tidak sesuai.', 502);
    }
    return data as unknown[];
  }

  public async getDanbooru(tags: string, limit: number): Promise<unknown> {
    const url = `https://danbooru.donmai.us/posts.json?limit=${limit}&tags=${encodeURIComponent(tags)}+rating:explicit`;
    return this.fetchJson(url, 'Danbooru');
  }

  public async getWaifuIm(tag: string, isNsfw: boolean = true): Promise<unknown> {
    const url = `https://api.waifu.im/images?IncludedTags=${encodeURIComponent(tag)}&IsNsfw=${isNsfw}`;
    return this.fetchJson(url, 'WaifuIm');
  }

  public async getNhentaiGallery(id: string): Promise<unknown> {
    const url = `https://nhentai.net/api/v2/galleries/${encodeURIComponent(id)}`;
    return this.fetchJson(url, 'NHentai Gallery');
  }

  public async searchNhentai(query: string): Promise<unknown> {
    const url = `https://nhentai.net/api/v2/search?query=${encodeURIComponent(query)}`;
    return this.fetchJson(url, 'NHentai Search');
  }

  public async getPurrbot(category: string): Promise<unknown> {
    const url = `https://purrbot.site/api/img/nsfw/${encodeURIComponent(category)}/gif`;
    return this.fetchJson(url, 'PurrBot');
  }
}
