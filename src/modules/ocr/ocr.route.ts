import { Router } from 'express';
import { extractText } from './ocr.controller';

const router = Router();

router.post('/', extractText);

export default router;
