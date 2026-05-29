import { Router } from 'express';
import { downloadTwitterHandler } from './twitter.controller';

const router = Router();

router.get('/download', downloadTwitterHandler);

export default router;
