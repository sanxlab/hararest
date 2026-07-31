import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { OcrService } from './ocr.service';

const ocrService = new OcrService();

export const extractTextHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return next(new AppError('No image buffer provided in request body.', 400));
    }

    const text = await ocrService.extractText(req.body);

    res.status(200).json({
      status: 'success',
      data: {
        text,
      }
    });
  } catch (error) {
    next(error);
  }
};
