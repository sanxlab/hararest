import { Router } from 'express';
import { createBratHandler } from './brat.controller';

const router = Router();

router.get('/', createBratHandler);

export default router;
