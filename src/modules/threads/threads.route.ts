import { Router } from 'express';
import { downloadThreadsHandler } from './threads.controller';

const router = Router();

router.get('/download', downloadThreadsHandler);

export default router;
