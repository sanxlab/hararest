import { AppError } from "../../utils/AppError";
import logger from "../../utils/logger";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

type UpstreamError = {
  name?: string;
  message?: string;
  response?: { statusCode?: number };
};

function errorDetails(error: unknown): UpstreamError {
  return typeof error === 'object' && error !== null ? error as UpstreamError : {};
}

export class NsfwService {
  private async getGotScraping() {
    const gotScrapingModule = await import("got-scraping");
    return gotScrapingModule.gotScraping;
  }

  private async fetchWithPuppeteer(url: string, source: string): Promise<unknown> {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const content = await page.evaluate(() => document.body.innerText);

      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        if (!content || content.includes("Just a moment") || content.includes("Cloudflare") || content.includes("Enable JavaScript")) {
          throw new AppError(`${source} masih diblokir oleh Cloudflare (Akses Datacenter ditolak).`, 502);
        }
        throw new AppError(`Gagal mem-parsing response Puppeteer dari ${source}`, 502);
      }

      if (typeof parsed === 'string' && (parsed.includes("Missing authentication") || parsed.includes("Cloudflare"))) {
        throw new AppError(`${source} API menolak akses (Missing authentication / diblokir).`, 502);
      }

      return parsed;
    } catch (error: unknown) {
      if (error instanceof AppError) throw error;
      const details = errorDetails(error);
      const message = details.message || 'Unknown error';
      logger.error(`${source} puppeteer failed`, { error: message });
      throw new AppError(`Puppeteer gagal mengakses ${source}: ${message}`, 502);
    } finally {
      if (browser) await browser.close();
    }
  }

  private async fetchJson(url: string, source: string): Promise<unknown> {
    try {
      const gotScraping = await this.getGotScraping();
      const response = await gotScraping.get(url, {
        responseType: "json",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json"
        }
      });

      if (typeof response.body === "string") {
        if (response.body.includes("<html") || response.body.includes("Just a moment") || response.body.includes("Missing authentication")) {
          return this.fetchWithPuppeteer(url, source);
        }
        if (response.body.includes("Use new API")) {
          throw new AppError(`${source} API telah usang atau berubah.`, 502);
        }
      }

      return response.body;
    } catch (error: unknown) {
      const details = errorDetails(error);
      if (details.name === 'ParseError' || details.response?.statusCode === 403 || details.response?.statusCode === 503) {
        return this.fetchWithPuppeteer(url, source);
      }
      if (error instanceof AppError) throw error;
      const message = details.message || 'Unknown error';
      logger.error(`${source} request failed`, { error: message });
      throw new AppError(`Gagal mengambil data dari ${source}: ${message}`, 502);
    }
  }

  public async getDanbooru(tags: string, limit: number): Promise<unknown> {
    const url = `https://danbooru.donmai.us/posts.json?limit=${limit}&tags=${encodeURIComponent(tags)}+rating:explicit`;
    return this.fetchJson(url, "Danbooru");
  }

  public async getWaifuIm(tag: string, isNsfw: boolean = true): Promise<unknown> {
    const url = `https://api.waifu.im/images?IncludedTags=${encodeURIComponent(tag)}&isNsfw=${isNsfw}`;
    return this.fetchJson(url, "WaifuIm");
  }

  public async getNhentaiGallery(id: string): Promise<unknown> {
    const url = `https://nhentai.net/api/v2/galleries/${encodeURIComponent(id)}`;
    return this.fetchJson(url, "NHentai Gallery");
  }

  public async searchNhentai(query: string): Promise<unknown> {
    const url = `https://nhentai.net/api/v2/search?query=${encodeURIComponent(query)}`;
    return this.fetchJson(url, "NHentai Search");
  }

  public async getPurrbot(category: string): Promise<unknown> {
    const url = `https://purrbot.site/api/img/nsfw/${encodeURIComponent(category)}/gif`;
    return this.fetchJson(url, "PurrBot");
  }
}
