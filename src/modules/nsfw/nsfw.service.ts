import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { publicLookup } from '../../utils/publicAgent';

type UpstreamError = {
  name?: string;
  message?: string;
  response?: { statusCode?: number };
};

function errorDetails(error: unknown): UpstreamError {
  return typeof error === 'object' && error !== null ? (error as UpstreamError) : {};
}

export class NsfwService {
  private async getGotScraping() {
    const gotScrapingModule = await import('got-scraping');
    return gotScrapingModule.gotScraping;
  }

  private async fetchJson(url: string, source: string): Promise<unknown> {
    try {
      const gotScraping = await this.getGotScraping();
      const response = await gotScraping.get(url, {
        responseType: 'json',
        timeout: { request: 15000 },
        retry: { limit: 1 },
        followRedirect: false,
        dnsLookup: publicLookup,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      });

      if (typeof response.body === 'string') {
        if (
          /<html|<!doctype|Just a moment|Missing authentication|Cloudflare|Enable JavaScript/i.test(
            response.body,
          )
        ) {
          throw new AppError(`${source} menolak akses atau mengembalikan halaman verifikasi.`, 502);
        }
        if (response.body.includes('Use new API')) {
          throw new AppError(`${source} API telah usang atau berubah.`, 502);
        }
      }

      return response.body;
    } catch (error: unknown) {
      const details = errorDetails(error);
      if (details.response?.statusCode === 403 || details.response?.statusCode === 503) {
        throw new AppError(
          `${source} menolak akses atau sedang tidak tersedia (HTTP ${details.response.statusCode}).`,
          502,
        );
      }
      if (details.name === 'ParseError') {
        throw new AppError(
          `${source} mengembalikan respons JSON tidak valid atau halaman verifikasi.`,
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
