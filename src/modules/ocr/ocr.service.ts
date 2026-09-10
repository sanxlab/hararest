import { spawn } from 'child_process';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

export class OcrService {
  public extractText(imageBuffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const tesseract = spawn('tesseract', ['-', 'stdout', '-l', 'ind+eng']);
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

      tesseract.stdout.on('data', (data: Buffer) => {
        outData += data.toString();
        if (outData.length > 5 * 1024 * 1024) {
          tesseract.kill('SIGKILL');
          finish(new AppError('OCR output is too large.', 502));
        }
      });
      tesseract.stderr.on('data', (data: Buffer) => {
        errData = (errData + data.toString()).slice(-8192);
      });
      tesseract.on('error', (error) => {
        logger.error('Failed to start tesseract process', { error });
        finish(new AppError('OCR engine failed to start.', 500));
      });
      // An early-exiting process can close stdin before the image is written.
      tesseract.stdin.on('error', () => {
        tesseract.kill('SIGKILL');
        finish(new AppError('OCR engine could not read the image.', 502));
      });
      tesseract.on('close', (code) => {
        if (code !== 0) {
          logger.error('Tesseract failed', { code, error: errData });
          finish(new AppError('OCR could not process the image.', 422));
        } else finish();
      });
      tesseract.stdin.end(imageBuffer);
    });
  }
}
