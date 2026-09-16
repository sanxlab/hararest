import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { BilibiliService } from './bilibili.service';

const service = new BilibiliService();

export const downloadBilibiliHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, quality, page } = req.query;
    if (typeof url !== 'string' || !url.trim()) throw new AppError('URL is required.', 400);
    const data = await service.download(
      url,
      quality as string | undefined,
      page as string | undefined,
    );
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
};
