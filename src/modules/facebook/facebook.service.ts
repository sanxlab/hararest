import { config } from '../../config/default';
import logger from '../../utils/logger';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { getMediaSize, bytesToSize } from '../../utils/mediaSize';
import { AppError } from '../../utils/AppError';
import { FacebookVideoInfo, FacebookVideo } from './facebook.types';
import { getPublicPage } from '../../utils/http';

const execFilePromise = util.promisify(execFile);
const allowedFacebookHosts = ['facebook.com', 'fb.watch', 'fb.gg'] as const;

interface FDownMediaLink {
  quality?: string;
  label?: string;
  url: string;
}

interface FDownResponse {
  status?: string;
  message?: string;
  media_links?: FDownMediaLink[];
}

interface FacebookYtDlpFormat {
  url?: string;
  ext?: string;
  format_id?: string;
  height?: number;
  acodec?: string;
  vcodec?: string;
  filesize?: number;
}

export class FacebookService {
  private readonly pythonBin = process.env.PYTHON_BIN || 'python';

  private resolveFDownScriptPath(): string {
    const envScriptPath = process.env.FACEBOOK_FALLBACK_PYTHON_SCRIPT;
    const candidates = [
      envScriptPath,
      path.resolve(process.cwd(), 'src/modules/facebook/fdown_scraper.py'),
      path.resolve(process.cwd(), 'fdown_scraper.py'),
    ].filter((x): x is string => !!x);

    const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) {
      throw new AppError('FDown fallback script not found', 500);
    }

    return scriptPath;
  }

  private extractScriptError(stderr: string, fallback = 'FDown fallback failed'): string {
    const raw = stderr.trim();
    if (!raw) return fallback;

    try {
      const parsed = JSON.parse(raw) as { message?: string };
      return parsed?.message || fallback;
    } catch {
      return raw;
    }
  }

  private async resolveShareUrl(url: string): Promise<string> {
    const target = new URL(url);
    if (!target.pathname.toLowerCase().startsWith('/share/')) return url;

    const response = await getPublicPage<string>(url, allowedFacebookHosts, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml' },
      responseType: 'text',
    });
    const resolved = response.config.url || url;
    const finalUrl = new URL(resolved);
    const allowed = allowedFacebookHosts.some(
      (host) =>
        finalUrl.hostname.toLowerCase() === host ||
        finalUrl.hostname.toLowerCase().endsWith(`.${host}`),
    );
    if (!allowed) throw new AppError('Facebook share URL redirected to an unsupported host.', 502);
    return finalUrl.toString();
  }

  private async getVideoInfoFromFDown(url: string): Promise<FacebookVideoInfo> {
    const scriptPath = this.resolveFDownScriptPath();

    let stdout = '';
    try {
      const run = await execFilePromise(this.pythonBin, [scriptPath, url], {
        maxBuffer: 1024 * 1024 * 10,
        timeout: 120000,
      });
      stdout = typeof run === 'string' ? run : run.stdout || '';
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string };
      const extracted = this.extractScriptError(
        err.stderr || '',
        err.message || 'FDown fallback failed',
      );
      throw new AppError(extracted, 500);
    }

    let parsed: FDownResponse;
    try {
      parsed = JSON.parse(stdout) as FDownResponse;
    } catch {
      throw new AppError('FDown fallback returned invalid JSON', 500);
    }

    if (!parsed || parsed.status !== 'ok') {
      throw new AppError(parsed?.message || 'FDown fallback failed', 500);
    }

    const links = Array.isArray(parsed.media_links)
      ? parsed.media_links.filter(
          (item) => !!item && typeof item.url === 'string' && item.url.length > 0,
        )
      : [];

    if (links.length === 0) {
      throw new AppError('Media not found or private', 404);
    }

    const videos: FacebookVideo[] = await Promise.all(
      links.map(async (link) => {
        const size = await getMediaSize(link.url);
        return {
          quality: (link.quality || link.label || 'unknown').trim(),
          url: link.url,
          size,
          fSize: bytesToSize(size),
        };
      }),
    );

    return {
      thumbnail: '',
      videos,
    };
  }

  private async getVideoInfoFromYtDlp(url: string): Promise<FacebookVideoInfo> {
    try {
      const run = await execFilePromise(
        config.youtube.binPath,
        [
          '--ignore-config',
          '--no-playlist',
          '--skip-download',
          '--socket-timeout',
          '15',
          '--retries',
          '1',
          '--dump-single-json',
          '--',
          url,
        ],
        { timeout: 90000, maxBuffer: 10 * 1024 * 1024 },
      );
      const stdout = typeof run === 'string' ? run : run.stdout;
      const data = JSON.parse(stdout) as { thumbnail?: string; formats?: FacebookYtDlpFormat[] };
      // DASH-only video/audio URLs cannot be played as a single downloaded file.
      const formats = Array.isArray(data?.formats)
        ? data.formats.filter(
            (format) =>
              format &&
              typeof format.url === 'string' &&
              /^https?:\/\//.test(format.url) &&
              format.ext === 'mp4' &&
              format.acodec !== 'none' &&
              format.vcodec !== 'none',
          )
        : [];
      const unique = formats.filter(
        (format, index) => formats.findIndex((item) => item.url === format.url) === index,
      );
      if (!unique.length) throw new AppError('No downloadable Facebook video found.', 404);
      const videos = await Promise.all(
        unique.map(async (format) => {
          const size =
            Number.isSafeInteger(format.filesize) && (format.filesize || 0) > 0
              ? (format.filesize as number)
              : await getMediaSize(format.url as string);
          return {
            quality:
              format.format_id?.toLowerCase().includes('hd') || (format.height || 0) >= 720
                ? 'hd'
                : 'sd',
            url: format.url as string,
            size,
            fSize: bytesToSize(size),
          };
        }),
      );
      return { thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : '', videos };
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.warn('Facebook yt-dlp fallback failed', { error });
      throw new AppError('Facebook video could not be retrieved from either extractor.', 502);
    }
  }

  public async getVideoInfo(url: string): Promise<FacebookVideoInfo> {
    if (!url) {
      throw new AppError('URL Required', 400);
    }

    try {
      const { hostname, protocol } = new URL(url);
      const normalizedHost = hostname.toLowerCase();
      const isAllowed = allowedFacebookHosts.some(
        (host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`),
      );
      if ((protocol !== 'http:' && protocol !== 'https:') || !isAllowed) {
        throw new AppError('Invalid URL', 400);
      }
    } catch {
      throw new AppError('Invalid URL', 400);
    }

    const resolvedUrl = await this.resolveShareUrl(url);

    try {
      return await this.getVideoInfoFromFDown(resolvedUrl);
    } catch (error) {
      logger.warn('FDown failed; trying the direct Facebook extractor', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.getVideoInfoFromYtDlp(resolvedUrl);
    }
  }
}
