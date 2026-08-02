import { Router } from 'express';
import { searchHandler } from './brave.controller';

const router = Router();

router.get('/search', searchHandler);

export default router;
