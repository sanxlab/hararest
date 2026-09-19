import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { WikipediaService } from './wikipedia.service';

const service = new WikipediaService();

export const scrapeWikipediaHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { url } = req.query;
    if (typeof url !== 'string' || !url.trim()) {
      throw new AppError('Query parameter "url" is required.', 400);
    }
    res.status(200).json({ status: 'success', data: await service.scrape(url) });
  } catch (error) {
    next(error);
  }
};
