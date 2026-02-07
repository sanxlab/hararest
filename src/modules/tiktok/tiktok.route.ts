import { Router } from 'express';
import {
    downloadTiktokHandler,
    trendingTiktokHandler,
    userTiktokHandler,
    searchTiktokHandler
} from './tiktok.controller';

const router = Router();

router.get('/download', downloadTiktokHandler);
router.get('/trending', trendingTiktokHandler);
router.get('/user', userTiktokHandler);
router.get('/search', searchTiktokHandler);

export default router;
