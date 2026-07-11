import { Router } from 'express';
import { getInstagramMediaHandler } from './instagram.controller';

const router = Router();

router.get('/', getInstagramMediaHandler);

export default router;
