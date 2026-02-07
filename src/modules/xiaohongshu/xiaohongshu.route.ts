import { Router } from 'express';
import { downloadXiaohongshuHandler } from './xiaohongshu.controller';

const router = Router();

router.get('/', downloadXiaohongshuHandler);

export default router;
