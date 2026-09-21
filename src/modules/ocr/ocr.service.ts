import { spawn } from 'child_process';
import sharp from 'sharp';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

const OCR_LIMITS = { concurrency: 2, maxBytes: 15 * 1024 * 1024, maxPixels: 16_000_000 };
let activeRequests = 0;

export class OcrService {
  public async extractText(imageBuffer: Buffer): Promise<string> {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0 || imageBuffer.length > OCR_LIMITS.maxBytes) {
      throw new AppError('OCR requires an image of at most 15 MiB.', 413);
    }
    if (activeRequests >= OCR_LIMITS.concurrency) {
      throw new AppError('OCR engine is busy. Try again shortly.', 503);
    }
    activeRequests++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests--;
    };
    let normalized: Buffer;
    try {
      const options = { limitInputPixels: OCR_LIMITS.maxPixels, animated: false };
      const metadata = await sharp(imageBuffer, options).metadata();
      if (!metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
        throw new AppError('OCR images must be PNG, JPEG, or WebP.', 422);
      }
      // Canonicalize a single bounded raster before the native OCR decoder runs.
      normalized = await sharp(imageBuffer, options).png().toBuffer();
    } catch (error) {
      release();
      if (error instanceof AppError) throw error;
      throw new AppError('OCR image is invalid or exceeds the pixel limit.', 422);
    }
    return this.run(normalized, release);
  }

  private run(imageBuffer: Buffer, release: () => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let tesseract: ReturnType<typeof spawn>;
      try {
        tesseract = spawn('tesseract', ['-', 'stdout', '-l', 'ind+eng'], {
          stdio: 'pipe', env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        });
      } catch {
        release();
        reject(new AppError('OCR engine failed to start.', 500));
        return;
      }
      let outData = '';
      let errData = '';
      let settled = false;
      const finish = (error?: AppError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(outData.trim());
      };
      const timeout = setTimeout(() => {
        tesseract.kill('SIGKILL');
        finish(new AppError('OCR processing timed out.', 504));
      }, 60000);
      timeout.unref();

      tesseract.stdout!.on('data', (data: Buffer) => {
        outData += data.toString();
        if (outData.length > 5 * 1024 * 1024) {
          tesseract.kill('SIGKILL');
          finish(new AppError('OCR output is too large.', 502));
        }
      });
      tesseract.stderr!.on('data', (data: Buffer) => {
        errData = (errData + data.toString()).slice(-8192);
      });
      tesseract.on('error', (error) => {
        logger.error('Failed to start tesseract process', { error });
        finish(new AppError('OCR engine failed to start.', 500));
      });
      // An early-exiting process can close stdin before the image is written.
      tesseract.stdin!.on('error', () => {
        tesseract.kill('SIGKILL');
        finish(new AppError('OCR engine could not read the image.', 502));
      });
      tesseract.on('close', (code) => {
        // A killed process keeps its capacity reservation until it really exits.
        release();
        if (code !== 0) {
          logger.error('Tesseract failed', { code, error: errData });
          finish(new AppError('OCR could not process the image.', 422));
        } else finish();
      });
      tesseract.stdin!.end(imageBuffer);
    });
  }
}
