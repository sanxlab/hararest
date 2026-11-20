import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import util from 'node:util';
import { AppError } from '../../utils/AppError';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { AvscanSearchResult } from './avscan.types';

const execFilePromise = util.promisify(execFile);

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
    let tempFilePath: string | null = null;
    let targetArg: string;

    if (Buffer.isBuffer(input)) {
      if (input.length < 50) {
        throw new AppError('Image buffer is too small or invalid', 400);
      }
      const tempFileName = `avscan-${Date.now()}-${randomBytes(6).toString('hex')}.jpg`;
      tempFilePath = path.join(os.tmpdir(), tempFileName);
      await fs.promises.writeFile(tempFilePath, input);
      targetArg = tempFilePath;
    } else if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) {
        throw new AppError('Image URL cannot be empty', 400);
      }
      await assertPublicUrl(trimmed);
      targetArg = trimmed;
    } else {
      throw new AppError('Invalid input for AVScan search', 400);
    }

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
      const err = error as { stderr?: string; message?: string; code?: string | number };
      const extracted = this.extractScriptError(err.stderr || '', err.message || 'AVScan service failed');

      if (extracted.includes('rate limit')) {
        throw new AppError(extracted, 429);
      }
      if (extracted.includes('timed out') || err.code === 'ETIMEDOUT') {
        throw new AppError('AVScan request timed out', 504);
      }
      if (extracted.includes('not found') || extracted.includes('too small') || extracted.includes('Invalid image')) {
        throw new AppError(extracted, 400);
      }
      throw new AppError(extracted, 502);
    } finally {
      if (tempFilePath) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
      }
    }
  }
}
