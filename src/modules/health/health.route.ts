import { Router } from 'express';
import { getHealthHandler } from './health.controller';

const router = Router();

router.get('/', getHealthHandler);

export default router;
