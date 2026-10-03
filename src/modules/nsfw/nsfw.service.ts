import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import axios from 'axios';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';

export class NsfwService {
  private async fetchJson(url: string, source: string): Promise<unknown> {
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
