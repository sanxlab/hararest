import { Request, Response, NextFunction } from 'express';
import { InstagramService } from './instagram.service';
import { InstagramStalkerService } from './instagram-stalker.service';
import { AppError } from '../../utils/AppError';

const instagramService = new InstagramService();

const parseBoolean = (value: unknown, defaultValue = false): boolean => {
    if (value === undefined) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return defaultValue;

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const parseOptionalNumber = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value.trim()) return null;

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

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

export const getInstagramStalkHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { username } = req.query;
        if (!username || typeof username !== 'string') {
            return next(new AppError('Username is required', 400));
        }

        const service = new InstagramStalkerService({
            targetUsername: username,
            includePosts: parseBoolean(req.query.includePosts),
            includeReels: parseBoolean(req.query.includeReels),
            includeAbout: parseBoolean(req.query.includeAbout, true),
            maxItems: parseOptionalNumber(req.query.maxItems),
            maxPages: parseOptionalNumber(req.query.maxPages),
            delayMs: parseOptionalNumber(req.query.delayMs) ?? undefined,
            jitterMs: parseOptionalNumber(req.query.jitterMs) ?? undefined,
            maxRetries: parseOptionalNumber(req.query.maxRetries) ?? undefined,
            backoffBaseMs: parseOptionalNumber(req.query.backoffBaseMs) ?? undefined,
            backoffMaxMs: parseOptionalNumber(req.query.backoffMaxMs) ?? undefined,
            backoffJitterMs: parseOptionalNumber(req.query.backoffJitterMs) ?? undefined,
            timeoutMs: parseOptionalNumber(req.query.timeoutMs) ?? undefined,
            warmupDelayMs: parseOptionalNumber(req.query.warmupDelayMs) ?? undefined,
            warmupJitterMs: parseOptionalNumber(req.query.warmupJitterMs) ?? undefined,
            profileOnlyOnRateLimit: parseBoolean(req.query.profileOnlyOnRateLimit, true),
            headful: parseBoolean(req.query.headful)
        });

        const data = await service.run();
        res.status(200).json({
            status: 'success',
            data
        });
    } catch (error) {
        next(error);
    }
};
