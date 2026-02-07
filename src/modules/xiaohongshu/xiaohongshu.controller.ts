import { Request, Response, NextFunction } from 'express';
import { XiaohongshuService } from './xiaohongshu.service';
import { AppError } from '../../utils/AppError';

const xiaohongshuService = new XiaohongshuService();

export const downloadXiaohongshuHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { url } = req.query;
        if (!url || typeof url !== 'string') {
            return next(new AppError('URL is required', 400));
        }

        const data = await xiaohongshuService.download(url);
        res.status(200).json({ status: 'success', data });
    } catch (error) {
        next(error);
    }
};
