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

export function normalizeFacebookInput(raw: string): string {
  let value = raw.trim();
  const markdown = value.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i);
  if (markdown) value = markdown[1];
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (value.startsWith('`') && value.endsWith('`')) value = value.slice(1, -1).trim();
  return value;
}

interface SnapSaveMediaLink {
  quality?: string;
  label?: string;
  url: string;
}

interface SnapSaveResponse {
  status?: string;
  message?: string;
  media_links?: SnapSaveMediaLink[];
}

export class FacebookService {
  private readonly pythonBin = process.env.PYTHON_BIN || 'python';

  private resolveSnapSaveScriptPath(): string {
    const envScriptPath = process.env.FACEBOOK_FALLBACK_PYTHON_SCRIPT;
    const candidates = [
      envScriptPath,
      path.resolve(process.cwd(), 'src/modules/facebook/snapsave_scraper.py'),
      path.resolve(process.cwd(), 'snapsave_scraper.py'),
    ].filter((x): x is string => !!x);

    const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) {
      throw new AppError('SnapSave fallback script not found', 500);
    }

    return scriptPath;
  }

  private extractScriptError(stderr: string, fallback = 'SnapSave fallback failed'): string {
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

  private async getVideoInfoFromSnapSave(url: string): Promise<FacebookVideoInfo> {
    const scriptPath = this.resolveSnapSaveScriptPath();

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
        err.message || 'SnapSave fallback failed',
      );
      throw new AppError(extracted, 500);
    }

    let parsed: SnapSaveResponse;
    try {
      parsed = JSON.parse(stdout) as SnapSaveResponse;
    } catch {
      throw new AppError('SnapSave fallback returned invalid JSON', 500);
    }

    if (!parsed || parsed.status !== 'ok') {
      throw new AppError(parsed?.message || 'SnapSave fallback failed', 500);
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

  public async getVideoInfo(url: string): Promise<FacebookVideoInfo> {
    url = normalizeFacebookInput(url || '');
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

    let resolvedUrl = url;
    try {
      resolvedUrl = await this.resolveShareUrl(url);
    } catch (error) {
      logger.warn('Could not resolve Facebook share URL; trying original URL', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    try {
      return await this.getVideoInfoFromSnapSave(resolvedUrl);
    } catch (error) {
      logger.warn('SnapSave failed; no Facebook extractor fallback is configured', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new AppError('Facebook video could not be retrieved from SnapSave.', 502);
    }
  }
}
