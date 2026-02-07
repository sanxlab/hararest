import { Request, Response, NextFunction } from 'express';
import { TiktokService } from './tiktok.service';
import { AppError } from '../../utils/AppError';

const tiktokService = new TiktokService();

export const downloadTiktokHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { url } = req.query;
        if (!url || typeof url !== 'string') {
            return next(new AppError('URL is required', 400));
        }

        const data = await tiktokService.download(url);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};

export const trendingTiktokHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { region } = req.query;
        const data = await tiktokService.trendingFeed(region as string);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};

export const userTiktokHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { username, cursor } = req.query;
        if (!username || typeof username !== 'string') {
            return next(new AppError('Username is required', 400));
        }

        const data = await tiktokService.userFeed(username, cursor as string);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};

export const searchTiktokHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { query, cursor } = req.query;
        if (!query || typeof query !== 'string') {
            return next(new AppError('Query is required', 400));
        }

        const data = await tiktokService.search(query, cursor as string);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};
