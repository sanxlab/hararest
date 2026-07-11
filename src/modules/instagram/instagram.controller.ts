import { Request, Response, NextFunction } from 'express';
import { InstagramService } from './instagram.service';
import { AppError } from '../../utils/AppError';

const instagramService = new InstagramService();

export const getInstagramMediaHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { url } = req.query;

        if (!url || typeof url !== 'string') {
            return next(new AppError('URL is required', 400));
        }

        const info = await instagramService.getMediaInfo(url);

        res.status(200).json({
            status: 'success',
            data: info
        });
    } catch (error) {
        next(error);
    }
};
