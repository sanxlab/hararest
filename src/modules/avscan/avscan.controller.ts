import { Request, Response, NextFunction } from 'express';
import { AvscanService } from './avscan.service';
import { AppError } from '../../utils/AppError';

const avscanService = new AvscanService();

export const scanAvHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    let input: Buffer | string | undefined;

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      input = req.body;
    } else if (typeof req.query.url === 'string' && req.query.url.trim()) {
      input = req.query.url.trim();
    } else if (req.body && typeof req.body === 'object' && typeof req.body.url === 'string' && req.body.url.trim()) {
      input = req.body.url.trim();
    }

    if (!input) {
      return next(new AppError('Image file or image URL is required', 400));
    }

    const data = await avscanService.search(input);

    res.status(200).json({ status: 'success', data: data.results });
  } catch (error) {
    next(error);
  }
};
