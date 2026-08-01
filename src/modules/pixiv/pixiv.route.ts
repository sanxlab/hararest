import { Router } from 'express';
import { PixivController } from './pixiv.controller';

const router = Router();
const controller = new PixivController();

router.get('/', controller.download);
router.get('/search', controller.search);

export default router;
