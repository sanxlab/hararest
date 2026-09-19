import { Router } from 'express';
import { scrapeWikipediaHandler } from './wikipedia.controller';

const router = Router();
router.get('/scrape', scrapeWikipediaHandler);

export default router;
