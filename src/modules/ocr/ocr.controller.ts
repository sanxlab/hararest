import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { spawn } from 'child_process';
import logger from '../../utils/logger';

export const extractText = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    return next(new AppError('No image buffer provided in request body.', 400));
  }

  // Tesseract reads from stdin if passed "-" or "stdin". We use "-" here.
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
    next(new AppError('OCR engine failed to start.', 500));
  });

  tesseract.on('close', (code) => {
    if (code !== 0) {
      logger.error('Tesseract error:', errData);
      return next(new AppError(`OCR failed with exit code ${code}`, 500));
    }

    const text = outData.trim();
    res.json({
      success: true,
      data: {
        text,
      }
    });
  });

  // Write image buffer to stdin
  tesseract.stdin.write(req.body);
  tesseract.stdin.end();
};
