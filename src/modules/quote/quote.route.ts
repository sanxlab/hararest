import { Router } from 'express';
import { QuoteService } from './quote.service';

const router = Router();
const service = new QuoteService();
router.post(['/', '/generate'], async (req, res, next) => {
  try {
    const result = await service.generate(req.body);
    res.status(200).json({ ok: true, result });
  } catch (error) {
    next(error);
  }
});
export default router;
