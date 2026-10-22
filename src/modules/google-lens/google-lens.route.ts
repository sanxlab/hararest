import { Router } from 'express';
import { AppError } from '../../utils/AppError';
import { GoogleLensService } from './google-lens.service';

const router = Router();
const service = new GoogleLensService();

router.post('/', async (req, res, next) => {
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);
  try {
    const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType || '')) {
      throw new AppError('Content-Type must be image/jpeg, image/png, or image/webp.', 415);
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new AppError('Image request body is required.', 400);
    }
    const requestedMode = req.query.mode ?? 'visual';
    if (requestedMode !== 'ai' && requestedMode !== 'visual') {
      throw new AppError('mode must be either ai or visual.', 400);
    }
    const data = await service.search(req.body, requestedMode, controller.signal);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  } finally {
    res.off('close', onClose);
  }
});

export default router;
