import { Router } from 'express';
import { PinterestController } from './pinterest.controller';

const router = Router();
const controller = new PinterestController();

router.get('/', controller.download);
router.get('/search', controller.search);

export default router;
