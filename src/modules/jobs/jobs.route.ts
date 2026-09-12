import { Router, Request, Response, NextFunction } from 'express';
import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../utils/AppError';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { YoutubeService } from '../youtube/youtube.service';
import { PlayerService } from '../player/player.service';
import { playerService } from '../player/player.route';
import { buildPlayerHtml } from '../player/player.html';
import { JOB_LIMITS, JobService } from './jobs.service';
import { config } from '../../config/default';

const downloadSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  format: z.enum(['audio', 'video']),
  quality: z.string().regex(/^[1-9]\d{1,3}p?$/).optional(),
}).strict();
const playerSchema = z.object({
  query: z.string().trim().min(1).max(500),
  baseUrl: z.string().max(2048).optional(),
}).strict();

export function createJobRoutes(jobs: JobService, youtube: Pick<YoutubeService, 'downloadAudio' | 'downloadVideo'>, player: PlayerService) {
  const statusRouter = Router();
  statusRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  statusRouter.param('id', (_req, _res, next, value: string) => {
    next(/^[a-f0-9]{48}$/.test(value) ? undefined : new AppError('Job tidak ditemukan atau sudah kedaluwarsa.', 410));
  });
  statusRouter.get('/:id', (req, res) => {
    res.set('Retry-After', '3').json({ status: 'success', data: jobs.get(req.params.id) });
  });
  statusRouter.get('/:id/file', (req, res, next) => {
    const lease = jobs.acquireFile(req.params.id);
    res.once('close', lease.release);
    res.setTimeout(10 * 60_000);
    res.type(lease.file.mimeType).download(lease.file.path, lease.file.mimeType === 'audio/mpeg' ? 'audio.mp3' : 'video.mp4', (error) => {
      lease.release();
      res.off('close', lease.release);
      if (error && !res.destroyed) next(error);
    });
  });

  const createDownload = (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = downloadSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError('Body harus berisi url, format audio/video, dan quality opsional seperti 720p.', 400);
      const input = parsed.data;
      // Syntax/host validation is immediate; DNS validation runs in the worker.
      let url: URL;
      try { url = new URL(input.url); } catch { throw new AppError('URL YouTube tidak valid.', 400); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !['youtube.com', 'youtu.be'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
        throw new AppError('Gunakan URL HTTP(S) YouTube tanpa kredensial atau port khusus.', 400);
      }
      if (input.format === 'audio') delete input.quality;
      const job = jobs.submit(JSON.stringify(input), async signal => {
        await assertPublicUrl(input.url, ['youtube.com', 'youtu.be']);
        signal.throwIfAborted();
        const options = { signal, maxBytes: JOB_LIMITS.maxFileBytes };
        const file = input.format === 'audio'
          ? await youtube.downloadAudio(input.url, options)
          : await youtube.downloadVideo(input.url, input.quality, options);
        try {
          signal.throwIfAborted();
          const info = await stat(file);
          return { kind: 'file', path: file, size: info.size, mimeType: input.format === 'audio' ? 'audio/mpeg' : 'video/mp4' };
        } catch (error) { await unlink(file).catch(() => undefined); throw error; }
      }, req.get('Idempotency-Key'));
      res.set('Cache-Control', 'no-store').set('Location', `/api/jobs/${job.id}`).set('Retry-After', '3')
        .status(202).json({ status: 'success', data: job });
    } catch (error) { next(error); }
  };

  const createPlayer = (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = playerSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError('Body harus berisi query lagu dan baseUrl opsional.', 400);
      const input = { ...parsed.data, baseUrl: parsed.data.baseUrl ?? `${req.protocol}://${req.get('host')}` };
      const job = jobs.submit(JSON.stringify({ type: 'player', ...input }), async signal => {
        const track = await player.prepare(input.query, signal, input.baseUrl);
        return { kind: 'player', data: { ...track, html: buildPlayerHtml(track) }, dispose: () => player.remove(track.id) };
      }, req.get('Idempotency-Key'));
      res.set('Cache-Control', 'no-store').set('Location', `/api/jobs/${job.id}`).set('Retry-After', '3')
        .status(202).json({ status: 'success', data: job });
    } catch (error) { next(error); }
  };
  return { statusRouter, createDownload, createPlayer };
}

const spoolDir = path.join(config.youtube.tmpDir, 'jobs');
export const jobService = new JobService(JOB_LIMITS, config.nodeEnv === 'test' ? undefined : spoolDir);
export const jobRoutes = createJobRoutes(jobService, new YoutubeService(spoolDir), playerService);
