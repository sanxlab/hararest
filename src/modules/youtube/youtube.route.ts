import { Router } from 'express';
import { downloadAudioHandler, downloadVideoHandler, getInfoHandler } from './youtube.controller';

const router = Router();

router.get('/info', getInfoHandler);
router.get('/video', downloadVideoHandler);
router.get('/audio', downloadAudioHandler);

export default router;
