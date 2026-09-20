import { Router } from 'express';
import { scrapeWikipediaHandler, searchWikipediaHandler } from './wikipedia.controller';

const router = Router();
router.get('/scrape', scrapeWikipediaHandler);
router.get('/search', searchWikipediaHandler);

export default router;
