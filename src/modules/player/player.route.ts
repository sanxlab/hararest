import { Router } from 'express';
import { config } from '../../config/default';
import { YoutubeService } from '../youtube/youtube.service';
import { PlayerService } from './player.service';
import { buildPlayerHtml } from './player.html';

export function createPlayerRouters(service: PlayerService) {
  const apiRouter = Router();
  const pageRouter = Router();

  apiRouter.post('/sessions', async (req, res, next) => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(9 * 60_000)]);
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    req.setTimeout(10 * 60_000);
    res.setTimeout(10 * 60_000);
    try {
      const baseUrl = req.body?.baseUrl ?? `${req.protocol}://${req.get('host')}`;
      const track = await service.prepare(req.body?.query, signal, baseUrl);
      if (signal.aborted || res.destroyed) {
        service.remove(track.id);
        return;
      }
      res.set('Cache-Control', 'no-store').status(201).json({ status: 'success', data: { ...track, html: buildPlayerHtml(track) } });
    } catch (error) {
      if (!res.destroyed) next(error);
    } finally {
      res.off('close', onClose);
    }
  });

  pageRouter.get('/:id', (req, res) => {
    const session = /^[a-f0-9]{48}$/.test(req.params.id) ? service.get(req.params.id) : undefined;
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    if (!session) {
      res.status(410).type('text').send('Sesi player sudah berakhir atau tidak ditemukan. Jalankan playws lagi.');
      return;
    }
    const wsOrigin = new URL(session.track.wsUrl).origin;
    res.set('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${wsOrigin}; media-src blob:; base-uri 'none'; frame-ancestors 'none'`);
    res.type('html').send('<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kotonehara Player</title></head><body>' + buildPlayerHtml(session.track) + '</body></html>');
  });
  return { apiRouter, pageRouter };
}

export const playerService = new PlayerService(new YoutubeService(), config.playerPublicUrl);
export const { apiRouter: playerApiRouter, pageRouter: playerPageRouter } = createPlayerRouters(playerService);
