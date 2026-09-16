import { Router } from 'express';
import { downloadBilibiliHandler } from './bilibili.controller';

const router = Router();
router.get('/', downloadBilibiliHandler);
router.get('/download', downloadBilibiliHandler);
export default router;
