import { Router } from 'express';
import { scanAvHandler } from './avscan.controller';

const router = Router();

router.get('/', scanAvHandler);
router.post('/', scanAvHandler);

export default router;
