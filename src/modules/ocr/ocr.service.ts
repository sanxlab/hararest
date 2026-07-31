import { spawn } from 'child_process';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

export class OcrService {
  public extractText(imageBuffer: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const tesseract = spawn('tesseract', ['-', 'stdout', '-l', 'ind+eng']);

      let outData = '';
      let errData = '';

      tesseract.stdout.on('data', (data) => {
        outData += data.toString();
      });

      tesseract.stderr.on('data', (data) => {
        errData += data.toString();
      });

      tesseract.on('error', (err) => {
        logger.error('Failed to start tesseract process:', err);
        reject(new AppError('OCR engine failed to start.', 500));
      });

      tesseract.on('close', (code) => {
        if (code !== 0) {
          logger.error('Tesseract error:', errData);
          return reject(new AppError(`OCR failed with exit code ${code}`, 500));
        }

        const text = outData.trim();
        resolve(text);
      });

      tesseract.stdin.write(imageBuffer);
      tesseract.stdin.end();
    });
  }
}
