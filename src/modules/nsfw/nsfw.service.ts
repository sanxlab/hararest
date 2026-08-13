import { AppError } from "../../utils/AppError";
import logger from "../../utils/logger";

export class NsfwService {
  private async getGotScraping() {
    const gotScrapingModule = await import("got-scraping");
    return gotScrapingModule.gotScraping;
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
        if (response.body.includes("<html") || response.body.includes("Just a moment")) {
          throw new AppError(`${source} diblokir oleh Cloudflare. (Proxy gagal membypass)`, 502);
        }
        if (response.body.includes("Use new API")) {
          throw new AppError(`${source} API telah usang atau berubah.`, 502);
        }
      }
      
      return response.body;
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      logger.error(`${source} request failed`, { error: error.message });
      throw new AppError(`Gagal mengambil data dari ${source}: ${error.message}`, 502);
    }
  }

  public async getRule34(tags: string, limit: number): Promise<any> {
    const url = `https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=${limit}&tags=${encodeURIComponent(tags)}`;
    return this.fetchJson(url, "Rule34");
  }

  public async getDanbooru(tags: string, limit: number): Promise<any> {
    const url = `https://danbooru.donmai.us/posts.json?limit=${limit}&tags=${encodeURIComponent(tags)}+rating:explicit`;
    return this.fetchJson(url, "Danbooru");
  }

  public async getWaifuIm(tag: string, nsfw: boolean): Promise<any> {
    const url = `https://api.waifu.im/search?included_tags=${encodeURIComponent(tag)}&is_nsfw=${nsfw}`;
    return this.fetchJson(url, "WaifuIm");
  }

  public async getNhentaiGallery(id: string): Promise<any> {
    const url = `https://nhentai.net/api/gallery/${encodeURIComponent(id)}`;
    return this.fetchJson(url, "NHentai Gallery");
  }

  public async searchNhentai(query: string): Promise<any> {
    const url = `https://nhentai.net/api/galleries/search?query=${encodeURIComponent(query)}`;
    return this.fetchJson(url, "NHentai Search");
  }

  public async getPurrbot(category: string): Promise<any> {
    const url = `https://purrbot.site/api/img/nsfw/${encodeURIComponent(category)}/gif`;
    return this.fetchJson(url, "PurrBot");
  }
}
