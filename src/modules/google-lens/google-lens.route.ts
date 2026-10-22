import { createHash } from 'node:crypto';
import { Request, Response, Router } from 'express';
import { AppError } from '../../utils/AppError';
import { JobService } from '../jobs/jobs.service';
import { jobService } from '../jobs/jobs.route';
import { GoogleLensService } from './google-lens.service';

export function createGoogleLensRouter(
  service: Pick<GoogleLensService, 'search'>,
  jobs: JobService,
) {
  const router = Router();
  router.post('/', (req: Request, res: Response, next) => {
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
      const mode = requestedMode as 'ai' | 'visual';
      const image = req.body as Buffer;
      const fingerprint = createHash('sha256').update(mode).update('\0').update(image).digest('hex');
      const job = jobs.submit(fingerprint, async signal => ({
        kind: 'data' as const,
        data: await service.search(image, mode, signal),
      }), req.get('Idempotency-Key'));
      res.set('Cache-Control', 'no-store')
        .set('Location', `/api/jobs/${job.id}`)
        .set('Retry-After', String(Math.ceil(job.pollAfterMs / 1000)))
        .status(202)
        .json({ status: 'success', data: job });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

const service = new GoogleLensService();
export default createGoogleLensRouter(service, jobService);
