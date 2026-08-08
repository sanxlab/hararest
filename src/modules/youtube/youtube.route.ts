import { Router } from 'express';
import { downloadAudioHandler, downloadVideoHandler, getInfoHandler, searchHandler } from './youtube.controller';

const router = Router();

router.get('/search', searchHandler);
router.get('/info', getInfoHandler);
router.get('/video', downloadVideoHandler);
router.get('/audio', downloadAudioHandler);

export default router;
