import { AppError } from "../../utils/AppError";
import logger from "../../utils/logger";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

export class NsfwService {
  private async getGotScraping() {
    const gotScrapingModule = await import("got-scraping");
    return gotScrapingModule.gotScraping;
  }

  private async fetchWithPuppeteer(url: string, source: string): Promise<any> {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      const content = await page.evaluate(() => document.body.innerText);
      
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        if (!content || content.includes("Just a moment") || content.includes("Cloudflare") || content.includes("Enable JavaScript")) {
          throw new AppError(`${source} masih diblokir oleh Cloudflare (Akses Datacenter ditolak).`, 502);
        }
        throw new AppError(`Gagal mem-parsing response Puppeteer dari ${source}`, 502);
      }
      
      if (typeof parsed === 'string') {
        if (parsed.includes("Missing authentication") || parsed.includes("Cloudflare")) {
           throw new AppError(`${source} API menolak akses (Missing authentication / diblokir).`, 502);
        }
      }
      
      return parsed;
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`${source} puppeteer failed`, { error: error.message });
      throw new AppError(`Puppeteer gagal mengakses ${source}: ${error.message}`, 502);
    } finally {
      if (browser) await browser.close();
    }
  }

  private async fetchJson(url: string, source: string): Promise<any> {
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
          return await this.fetchWithPuppeteer(url, source);
        }
        if (response.body.includes("Use new API")) {
          throw new AppError(`${source} API telah usang atau berubah.`, 502);
        }
      }
      
      return response.body;
    } catch (error: any) {
      if (error.name === 'ParseError' || error.response?.statusCode === 403 || error.response?.statusCode === 503) {
          return await this.fetchWithPuppeteer(url, source);
      }
      if (error instanceof AppError) throw error;
      logger.error(`${source} request failed`, { error: error.message });
      throw new AppError(`Gagal mengambil data dari ${source}: ${error.message}`, 502);
    }
  }

  public async getDanbooru(tags: string, limit: number): Promise<any> {
    const url = `https://danbooru.donmai.us/posts.json?limit=${limit}&tags=${encodeURIComponent(tags)}+rating:explicit`;
    return this.fetchJson(url, "Danbooru");
  }

  public async getWaifuIm(tag: string, isNsfw: boolean = true): Promise<any> {
    const url = `https://api.waifu.im/images?IncludedTags=${encodeURIComponent(tag)}&isNsfw=${isNsfw}`;
    return this.fetchJson(url, "WaifuIm");
  }

  public async getNhentaiGallery(id: string): Promise<any> {
    const url = `https://nhentai.net/api/v2/galleries/${encodeURIComponent(id)}`;
    return this.fetchJson(url, "NHentai Gallery");
  }

  public async searchNhentai(query: string): Promise<any> {
    const url = `https://nhentai.net/api/v2/search?query=${encodeURIComponent(query)}`;
    return this.fetchJson(url, "NHentai Search");
  }

  public async getPurrbot(category: string): Promise<any> {
    const url = `https://purrbot.site/api/img/nsfw/${encodeURIComponent(category)}/gif`;
    return this.fetchJson(url, "PurrBot");
  }
}
