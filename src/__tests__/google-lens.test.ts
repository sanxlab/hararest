import express from 'express';
import supertest from 'supertest';
import { errorHandler } from '../middlewares/error.middleware';
import { JOB_LIMITS, JobService } from '../modules/jobs/jobs.service';
import { createGoogleLensRouter } from '../modules/google-lens/google-lens.route';
import { GoogleLensResult, GoogleLensService } from '../modules/google-lens/google-lens.service';

const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const result: GoogleLensResult = {
  mode: 'visual', lensPage: 'https://lens.google.com/search', aiResponse: '',
  aiImageCards: [], aiImages: [], visualMatches: [{ title: 'Match', url: 'https://example.com', thumbnail: '' }],
  imagesOnPage: [], externalLinks: [], pageText: '',
};

it('accepts Lens searches as background jobs and keeps them running after the POST response', async () => {
  const jobs = new JobService({ ...JOB_LIMITS, concurrency: 1 });
  const search = jest.fn(async (_image: Buffer, _mode: 'ai' | 'visual', signal?: AbortSignal) => {
    expect(signal?.aborted).toBe(false);
    return result;
  });
  const app = express();
  app.use('/api/google-lens', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }),
    createGoogleLensRouter({ search } as Pick<GoogleLensService, 'search'>, jobs));
  app.get('/api/jobs/:id', (req, res) => res.json({ status: 'success', data: jobs.get(req.params.id) }));
  app.use(errorHandler);

  try {
    const api = supertest(app);
    const key = 'lens-test-key-123456';
    const response = await api.post('/api/google-lens?mode=visual')
      .set('Content-Type', 'image/png').set('Idempotency-Key', key).send(image);
    expect(response.status).toBe(202);
    expect(response.headers.location).toBe(`/api/jobs/${response.body.data.id}`);
    const duplicate = await api.post('/api/google-lens?mode=visual')
      .set('Content-Type', 'image/png').set('Idempotency-Key', key).send(image);
    expect(duplicate.body.data.id).toBe(response.body.data.id);

    let status = await api.get(`/api/jobs/${response.body.data.id}`);
    for (let attempt = 0; attempt < 50 && status.body.data.state !== 'ready'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2));
      status = await api.get(`/api/jobs/${response.body.data.id}`);
    }
    expect(status.body.data).toMatchObject({
      state: 'ready', result: { kind: 'data', data: { mode: 'visual', visualMatches: [{ title: 'Match' }] } },
    });
    expect(search).toHaveBeenCalledTimes(1);
  } finally {
    await jobs.close();
  }
});

it('rejects invalid modes before queueing a Lens job', async () => {
  const jobs = new JobService({ ...JOB_LIMITS, concurrency: 1 });
  const search = jest.fn();
  const app = express();
  app.use('/api/google-lens', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }),
    createGoogleLensRouter({ search } as unknown as Pick<GoogleLensService, 'search'>, jobs));
  app.use(errorHandler);
  try {
    const response = await supertest(app).post('/api/google-lens?mode=bad')
      .set('Content-Type', 'image/png').send(image);
    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  } finally {
    await jobs.close();
  }
});
