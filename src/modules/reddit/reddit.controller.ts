import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { RedditService } from './reddit.service';

const service = new RedditService();

export const downloadRedditHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.query;
    if (typeof url !== 'string' || !url.trim()) throw new AppError('URL is required.', 400);
    res.status(200).json({ status: 'success', data: await service.download(url) });
  } catch (error) {
    next(error);
  }
};
