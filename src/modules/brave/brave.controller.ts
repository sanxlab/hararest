import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { BraveService } from './brave.service';

const braveService = new BraveService();

export const searchHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { q, num } = req.query;

    if (!q || typeof q !== 'string') {
      return next(new AppError('Query parameter "q" is required.', 400));
    }

    if (num !== undefined && typeof num !== 'string') {
      return next(new AppError('Parameter "num" must be an integer.', 400));
    }

    const results = await braveService.search(q, num === undefined ? 5 : Number(num));

    res.status(200).json({
      status: 'success',
      data: results,
    });
  } catch (error) {
    next(error);
  }
};
