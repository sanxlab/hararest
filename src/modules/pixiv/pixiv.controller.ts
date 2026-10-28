import { Request, Response, NextFunction } from 'express';
import { PixivService } from './pixiv.service';
import { AppError } from '../../utils/AppError';

export class PixivController {
    private pixivService: PixivService;

    constructor() {
        this.pixivService = new PixivService();
    }

    public download = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.query.id || req.query.url;
            
            if (!id || typeof id !== 'string') {
                throw new AppError('Pixiv ID or URL (id / url) is required', 400);
            }

            const data = await this.pixivService.download(id);
            
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
            const { q, nsfw, mode } = req.query;

            if (!q || typeof q !== 'string') {
                throw new AppError('Search query (q) is required', 400);
            }

            const isNsfw = nsfw === 'true' || nsfw === '1';
            const searchMode = mode === 'r18' || mode === 'safe' || mode === 'all' ? mode : undefined;
            const data = await this.pixivService.search(q, { nsfw: isNsfw, mode: searchMode });

            res.json({
                success: true,
                data
            });
        } catch (error) {
            next(error);
        }
    };

    public user = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const id = req.query.id || req.query.url || req.query.userId || req.query.user;

            if (!id || typeof id !== 'string') {
                throw new AppError('Pixiv user ID or URL (id / url) is required', 400);
            }

            const { nsfw, mode } = req.query;
            const isNsfw = nsfw === undefined ? undefined : nsfw === 'true' || nsfw === '1';
            const userMode = mode === 'r18' || mode === 'safe' || mode === 'all' ? mode : undefined;
            const data = await this.pixivService.user(id, { nsfw: isNsfw, mode: userMode });

            res.json({
                success: true,
                data
            });
        } catch (error) {
            next(error);
        }
    };
}
