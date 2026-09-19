import { Router } from 'express';
import { downloadRedditHandler } from './reddit.controller';

const router = Router();
router.get(['/', '/download'], downloadRedditHandler);
export default router;
