import { Request, Response, NextFunction } from 'express';
import { BratService } from './brat.service';
import { AppError } from '../../utils/AppError';

const bratService = new BratService();

export const createBratHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.query;

    if (!text) {
      return next(new AppError('Text is required', 400));
    }

    const imageBuffer = await bratService.create(text as string);

    res.set('Content-Type', 'image/png');
    res.send(imageBuffer);
  } catch (error) {
    next(error);
  }
};
