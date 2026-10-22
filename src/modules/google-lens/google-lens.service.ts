import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

const LIMITS = { concurrency: 1, maxBytes: 10 * 1024 * 1024, maxPixels: 20_000_000, timeoutMs: 90_000 };
const REMOTE_TIMEOUT_MS = 180_000;
let activeRequests = 0;
type LensWaiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: AppError) => void;
  onAbort?: () => void;
};
const lensWaiters: LensWaiter[] = [];

function releaseLensSlot() {
  activeRequests--;
  while (lensWaiters.length > 0) {
    const waiter = lensWaiters.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    if (waiter.signal?.aborted) {
      waiter.reject(new AppError('Google Lens search was cancelled.', 499));
      continue;
    }
    activeRequests++;
    waiter.resolve(releaseLensSlot);
    return;
  }
}

function acquireLensSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new AppError('Google Lens search was cancelled.', 499));
  if (activeRequests < LIMITS.concurrency) {
    activeRequests++;
    return Promise.resolve(releaseLensSlot);
  }
  return new Promise((resolve, reject) => {
    const waiter: LensWaiter = { signal, resolve, reject };
    waiter.onAbort = () => {
      const index = lensWaiters.indexOf(waiter);
      if (index < 0) return;
      lensWaiters.splice(index, 1);
      signal?.removeEventListener('abort', waiter.onAbort!);
      reject(new AppError('Google Lens search was cancelled.', 499));
    };
    lensWaiters.push(waiter);
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
  });
}

export interface GoogleLensResult {
  mode: 'ai' | 'visual';
  lensPage: string;
  aiResponse: string;
  aiImageCards: Array<{ title: string; sourceUrl: string; imageUrl: string; width: number; height: number }>;
  aiImages: Array<{ imageUrl: string; width: number; height: number; alt: string; sourceUrl: string }>;
  visualMatches: Array<{ title: string; url: string; thumbnail: string }>;
  imagesOnPage: Array<{ src: string; width: number; height: number; alt: string; pageUrl: string }>;
  externalLinks: Array<{ title: string; url: string }>;
  pageText: string;
}

export class GoogleLensService {
  public async search(imageBuffer: Buffer, mode: 'ai' | 'visual' = 'visual', signal?: AbortSignal): Promise<GoogleLensResult> {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
      throw new AppError('Kirim gambar JPEG, PNG, atau WebP.', 400);
    }
    if (imageBuffer.length > LIMITS.maxBytes) {
      throw new AppError('Ukuran gambar maksimal 10 MiB.', 413);
    }
    const release = await acquireLensSlot(signal);
    let tempDir: string | undefined;
    try {
      if (signal?.aborted) throw new AppError('Google Lens search was cancelled.', 499);
      const options = { limitInputPixels: LIMITS.maxPixels, animated: false };
      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(imageBuffer, options).metadata();
      } catch {
        throw new AppError('Data gambar tidak valid atau resolusinya melebihi batas.', 422);
      }
      if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
        throw new AppError('Format gambar harus JPEG, PNG, atau WebP.', 422);
      }
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > LIMITS.maxPixels) {
        throw new AppError('Resolusi gambar melebihi batas 20 megapiksel.', 422);
      }

      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hararest-lens-'));
      const imagePath = path.join(tempDir, 'image.jpg');
      try {
        await sharp(imageBuffer, options)
          .rotate()
          .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88, mozjpeg: true })
          .toFile(imagePath);
      } catch {
        throw new AppError('Data gambar tidak valid atau resolusinya melebihi batas.', 422);
      }
      return await this.run(imagePath, mode, signal);
    } finally {
      release();
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn('Failed to clean up Google Lens temporary image', { error });
      });
    }
  }

  private run(imagePath: string, mode: 'ai' | 'visual', signal?: AbortSignal): Promise<GoogleLensResult> {
    return new Promise((resolve, reject) => {
      if (process.env.GOOGLE_LENS_WORKER_URL) {
        this.runRemote(imagePath, mode, signal).then(resolve, reject);
        return;
      }
      if (process.env.NODE_ENV === 'production') {
        reject(new AppError('Google Lens worker is not configured.', 503));
        return;
      }

      const python = process.env.GOOGLE_LENS_PYTHON || '/opt/google-lens/bin/python';
      const script = path.join(process.cwd(), 'src/modules/google-lens/google_lens_scraper.py');
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(python, [script, imagePath, '--mode', mode], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (error) {
        logger.error('Failed to start Google Lens browser', { error });
        reject(new AppError('Google Lens browser is unavailable.', 503));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const killProcessTree = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      };
      const onAbort = () => {
        killProcessTree();
        finish(new AppError('Google Lens search was cancelled.', 499));
      };
      const finish = (error?: AppError, result?: GoogleLensResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new AppError('Google Lens returned an empty response.', 502));
      };
      const timeout = setTimeout(() => {
        killProcessTree();
        finish(new AppError('Google Lens search timed out. Try again later.', 504));
      }, LIMITS.timeoutMs);
      timeout.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 2 * 1024 * 1024) {
          killProcessTree();
          finish(new AppError('Google Lens response exceeded the size limit.', 502));
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      child.on('error', (error) => {
        logger.error('Google Lens browser process failed', { error });
        finish(new AppError('Google Lens browser is unavailable.', 503));
      });
      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          logger.warn('Google Lens search failed', { code, error: stderr });
          const blocked = /captcha|verifikasi|sorry/i.test(stderr);
          finish(new AppError(blocked ? 'Google Lens meminta verifikasi tambahan. Coba lagi nanti.' : 'Google Lens is temporarily unavailable.', blocked ? 503 : 502));
          return;
        }
        try {
          const result = JSON.parse(stdout) as GoogleLensResult;
          if (!result || !Array.isArray(result.visualMatches) || !Array.isArray(result.imagesOnPage) || !Array.isArray(result.externalLinks)) {
            throw new Error('Invalid result shape');
          }
          finish(undefined, result);
        } catch (error) {
          logger.error('Invalid Google Lens scraper response', { error });
          finish(new AppError('Google Lens returned an invalid response.', 502));
        }
      });
    });
  }

  private async runRemote(imagePath: string, mode: 'ai' | 'visual', signal?: AbortSignal): Promise<GoogleLensResult> {
    const token = process.env.GOOGLE_LENS_WORKER_TOKEN;
    if (!token) throw new AppError('Google Lens worker authentication is not configured.', 503);
    const accessClientId = process.env.CLOUDFLARE_ACCESS_CLIENT_ID;
    const accessClientSecret = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET;
    if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
      throw new AppError('Cloudflare Access credentials are incomplete.', 503);
    }

    let endpoint: URL;
    try {
      endpoint = new URL(process.env.GOOGLE_LENS_WORKER_URL as string);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('Unsupported worker URL');
      }
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/api/google-lens`;
      endpoint.searchParams.set('mode', mode);
    } catch {
      throw new AppError('Google Lens worker URL is invalid.', 503);
    }

    const timeoutController = new AbortController();
    // A second Heroku dyno may already be using the single-profile worker; allow
    // one full worker run to finish before this queued request reaches the browser.
    const timeout = setTimeout(() => timeoutController.abort(), REMOTE_TIMEOUT_MS);
    timeout.unref();
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    try {
      const image = await fs.readFile(imagePath);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'image/jpeg',
      };
      if (accessClientId && accessClientSecret) {
        headers['CF-Access-Client-Id'] = accessClientId;
        headers['CF-Access-Client-Secret'] = accessClientSecret;
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: image,
        redirect: 'error',
        signal: requestSignal,
      });

      const responseReader = response.body?.getReader();
      if (!responseReader) throw new AppError('Google Lens worker returned an empty response.', 502);
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      while (true) {
        const { done, value } = await responseReader.read();
        if (done) break;
        responseSize += value.byteLength;
        if (responseSize > 2 * 1024 * 1024) {
          await responseReader.cancel();
          throw new AppError('Google Lens response exceeded the size limit.', 502);
        }
        responseChunks.push(Buffer.from(value));
      }
      const responseText = Buffer.concat(responseChunks).toString('utf8');
      let payload: { status?: string; data?: GoogleLensResult; detail?: string };
      try {
        payload = JSON.parse(responseText) as typeof payload;
      } catch {
        throw new AppError('Google Lens worker returned an invalid response.', 502);
      }

      if (!response.ok) {
        const status = [400, 401, 413, 415, 422, 503, 504].includes(response.status)
          ? response.status
          : 502;
        throw new AppError(payload.detail || 'Google Lens worker is temporarily unavailable.', status);
      }
      const result = payload.data;
      if (
        payload.status !== 'success' ||
        !result ||
        result.mode !== mode ||
        !Array.isArray(result.visualMatches) ||
        !Array.isArray(result.imagesOnPage) ||
        !Array.isArray(result.externalLinks)
      ) {
        throw new AppError('Google Lens worker returned an invalid response.', 502);
      }
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal?.aborted) throw new AppError('Google Lens search was cancelled.', 499);
      if (timeoutController.signal.aborted) throw new AppError('Google Lens search timed out. Try again later.', 504);
      logger.warn('Google Lens worker request failed', { error });
      throw new AppError('Google Lens worker is unavailable.', 503);
    } finally {
      clearTimeout(timeout);
    }
  }
}
