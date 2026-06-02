import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/AppError';
import { ThreadsService } from './threads.service';

const threadsService = new ThreadsService();

export const downloadThreadsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { url } = req.query;
        if (!url || typeof url !== 'string') {
            return next(new AppError('URL is required', 400));
        }

        const data = await threadsService.download(url);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};
