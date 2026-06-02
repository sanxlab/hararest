import { Router } from 'express';
import { getInstagramMediaHandler, getInstagramStalkHandler } from './instagram.controller';

const router = Router();

router.get('/stalk', getInstagramStalkHandler);
router.get('/profile', getInstagramStalkHandler);
router.get('/', getInstagramMediaHandler);

export default router;
