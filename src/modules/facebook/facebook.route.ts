import { Router } from 'express';
import { getFacebookVideoHandler } from './facebook.controller';

const router = Router();

router.head('/', (_req, res) => res.status(405).end());
router.get('/', getFacebookVideoHandler);

export default router;
