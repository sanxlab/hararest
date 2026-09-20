import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { WikipediaService } from './wikipedia.service';
import { queryInteger } from '../../utils/query';

const service = new WikipediaService();

export const searchWikipediaHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { q, lang, limit } = req.query;
    if (typeof q !== 'string') throw new AppError('Query parameter "q" is required.', 400);
    if (lang !== undefined && typeof lang !== 'string')
      throw new AppError('Invalid Wikipedia language.', 400);
    res
      .status(200)
      .json({
        status: 'success',
        data: await service.search(q, lang, queryInteger(limit, 'limit', 5, 10)),
      });
  } catch (error) {
    next(error);
  }
};

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
