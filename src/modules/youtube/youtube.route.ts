import { Router } from 'express';
import { downloadAudioHandler, downloadVideoHandler, getInfoHandler, getPostHandler, searchHandler } from './youtube.controller';

const router = Router();

router.get('/search', searchHandler);
router.get('/info', getInfoHandler);
router.get('/post', getPostHandler);
router.get('/video', downloadVideoHandler);
router.get('/audio', downloadAudioHandler);

export default router;
