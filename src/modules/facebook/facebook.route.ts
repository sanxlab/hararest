import { Router } from 'express';
import { getFacebookVideoHandler } from './facebook.controller';

const router = Router();

router.get('/', getFacebookVideoHandler);

export default router;
