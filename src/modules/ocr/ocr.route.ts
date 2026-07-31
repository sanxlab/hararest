import { Router } from 'express';
import { extractTextHandler } from './ocr.controller';

const router = Router();

router.post('/', extractTextHandler);

export default router;
