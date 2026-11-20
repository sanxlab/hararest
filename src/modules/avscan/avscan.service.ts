import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import util from 'node:util';
import axios from 'axios';
import { AppError } from '../../utils/AppError';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { AvscanSearchResult } from './avscan.types';

const execFilePromise = util.promisify(execFile);

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/**
 * Download a user-supplied image URL in Node so every redirect hop is re-validated
 * and sockets only connect to public addresses. The Python scraper never fetches
 * user URLs itself.
 */
async function downloadPublicImage(input: string): Promise<Buffer> {
  let target = input;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(target);
    let response;
    try {
      response = await axios.get<ArrayBuffer>(target, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxRedirects: 0,
        maxContentLength: MAX_IMAGE_BYTES,
        proxy: false,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent,
        headers: {
          'User-Agent': 'Hararest/1.0',
          Accept: 'image/png,image/jpeg,image/webp',
        },
        validateStatus: (status) => (status >= 200 && status < 300) || REDIRECT_STATUSES.includes(status),
      });
    } catch {
      throw new AppError('Failed to download image from URL', 400);
    }
    if (REDIRECT_STATUSES.includes(response.status)) {
      const location = response.headers.location;
      if (typeof location !== 'string') throw new AppError('Image URL redirect has no location', 502);
      target = new URL(location, target).href;
      continue;
    }
    return Buffer.from(response.data);
  }
  throw new AppError('Too many image URL redirects', 400);
}

export class AvscanService {
  private readonly pythonBin = process.env.PYTHON_BIN || 'python';

  private resolveScriptPath(): string {
    const envPath = process.env.AVSCAN_PYTHON_SCRIPT;
    const candidates = [
      envPath,
      path.resolve(process.cwd(), 'src/modules/avscan/avscan_scraper.py'),
      path.resolve(__dirname, 'avscan_scraper.py'),
      path.resolve(process.cwd(), 'avscan_scraper.py'),
    ].filter((p): p is string => Boolean(p));

    const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!scriptPath) {
      throw new AppError('AVScan python scraper script not found', 500);
    }

    return scriptPath;
  }

  private extractScriptError(stderr: string, fallback = 'AVScan service failed'): string {
    const raw = stderr.trim();
    if (!raw) return fallback;

    try {
      const parsed = JSON.parse(raw) as { message?: string };
      return parsed?.message || fallback;
    } catch {
      return raw;
    }
  }

  public async search(input: Buffer | string): Promise<AvscanSearchResult> {
    const scriptPath = this.resolveScriptPath();

    let image: Buffer;
    if (Buffer.isBuffer(input)) {
      image = input;
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) {
        throw new AppError('Image URL cannot be empty', 400);
      }
      image = await downloadPublicImage(trimmed);
    } else {
      throw new AppError('Invalid input for AVScan search', 400);
    }

    if (image.length < 50) {
      throw new AppError('Image buffer is too small or invalid', 400);
    }
    if (image.length > MAX_IMAGE_BYTES) {
      throw new AppError('Image exceeds maximum size', 413);
    }

    const tempFileName = `avscan-${Date.now()}-${randomBytes(6).toString('hex')}.img`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);
    await fs.promises.writeFile(tempFilePath, image);
    const targetArg = tempFilePath;

    try {
      const { stdout } = await execFilePromise(
        this.pythonBin,
        [scriptPath, targetArg],
        { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }
      );

      const parsed = JSON.parse(stdout) as AvscanSearchResult;
      return {
        results: Array.isArray(parsed.results) ? parsed.results : [],
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message?: string; code?: string | number; killed?: boolean };
      const extracted = this.extractScriptError(err.stderr || '', err.message || 'AVScan service failed');

      if (extracted.includes('rate limit')) {
        throw new AppError(extracted, 429);
      }
      if (err.killed || extracted.includes('timed out') || err.code === 'ETIMEDOUT') {
        throw new AppError('AVScan request timed out', 504);
      }
      if (extracted.includes('not found') || extracted.includes('too small') || extracted.includes('Invalid image')) {
        throw new AppError(extracted, 400);
      }
      throw new AppError(extracted, 502);
    } finally {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
}
