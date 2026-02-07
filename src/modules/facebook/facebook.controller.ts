import { Request, Response, NextFunction } from 'express';
import { FacebookService } from './facebook.service';
import { AppError } from '../../utils/AppError';

const facebookService = new FacebookService();

export const getFacebookVideoHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { url } = req.query;

        if (!url || typeof url !== 'string') {
            return next(new AppError('URL is required', 400));
        }

        const info = await facebookService.getVideoInfo(url);

        res.status(200).json({
            status: 'success',
            data: info
        });
    } catch (error) {
        next(error);
    }
};
