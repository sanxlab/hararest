import { Request, Response, NextFunction } from 'express';
import { PinterestService } from './pinterest.service';
import { AppError } from '../../utils/AppError';

export class PinterestController {
    private pinterestService: PinterestService;

    constructor() {
        this.pinterestService = new PinterestService();
    }

    public download = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { url } = req.query;
            
            if (!url || typeof url !== 'string') {
                throw new AppError('URL is required', 400);
            }

            const data = await this.pinterestService.download(url);
            
            res.json({
                success: true,
                data
            });
        } catch (error) {
            next(error);
        }
    };

    public search = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { q } = req.query;
            
            if (!q || typeof q !== 'string') {
                throw new AppError('Search query (q) is required', 400);
            }

            const data = await this.pinterestService.search(q);
            
            res.json({
                success: true,
                data
            });
        } catch (error) {
            next(error);
        }
    };
}
