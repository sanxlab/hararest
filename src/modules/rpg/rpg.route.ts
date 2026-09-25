import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { config } from '../../config/default';

type GatewayConfig = { upstream: string; secret: string };
const routes = new Map([
  ['GET', /^\/(profile|catalog|gacha\/history)$/],
  [
    'POST',
    /^\/(session\/(exchange|logout)|battles|gacha\/pulls|battles\/[a-f0-9]{64}\/(actions|retreat))$/,
  ],
  ['PUT', /^\/party$/],
]);

export function createRpgRouter(settings: GatewayConfig): Router {
  const router = Router();
  const assets = path.resolve(process.cwd(), 'public/rpg');
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    next();
  });
  // This router mounts before the application's general CORS middleware. Only
  // same-origin browser sessions are used; client-supplied gateway headers are ignored.
  router.use(
    '/api',
    rateLimit({ windowMs: 60_000, limit: 900, standardHeaders: 'draft-7', legacyHeaders: false }),
    express.json({ limit: '16kb' }),
    async (req, res) => {
      if (!settings.upstream || !settings.secret) {
        res.status(503).json({
          error: {
            code: 'disabled',
            message: 'RPG belum diaktifkan pada server. Hubungi pemilik bot.',
          },
        });
        return;
      }
      if (!routes.get(req.method)?.test(req.path) || req.url.includes('?')) {
        res
          .status(404)
          .json({ error: { code: 'route_missing', message: 'Endpoint RPG tidak ditemukan.' } });
        return;
      }
      const headers: Record<string, string> = {
        'X-RPG-Gateway': settings.secret,
        Accept: 'application/json',
      };
      const cookie = (req.get('cookie') || '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => /^(?:__Secure-hara_rpg|hara_rpg_local)=[a-f0-9]{64}$/.test(part))
        .join('; ');
      if (cookie) headers.Cookie = cookie;
      for (const name of ['origin', 'x-csrf-token']) {
        const value = req.get(name);
        if (value) headers[name] = value;
      }
      if (req.method !== 'GET') headers['Content-Type'] = 'application/json';
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once('close', onClose);
      try {
        const upstream = await fetch(new URL(`/rpg/api${req.path}`, settings.upstream), {
          method: req.method,
          headers,
          body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
          redirect: 'manual',
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]),
        });
        if (upstream.status >= 300 && upstream.status < 400)
          throw new Error('Unexpected RPG redirect');
        if (!upstream.headers.get('content-type')?.startsWith('application/json'))
          throw new Error('Unexpected RPG response');
        // The upstream is a fixed, operator-configured origin. Bound reads as well
        // so a broken service cannot buffer an unlimited response in the gateway.
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error('Empty RPG response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 2 * 1024 * 1024) throw new Error('RPG response too large');
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        const body = Buffer.concat(chunks).toString('utf8');
        JSON.parse(body);
        const cookies = upstream.headers
          .getSetCookie()
          .filter((value) => /^(?:__Secure-hara_rpg|hara_rpg_local)=/.test(value));
        if (cookies.length) res.setHeader('Set-Cookie', cookies);
        res.status(upstream.status).type('json').send(body);
      } catch {
        if (!res.destroyed)
          res.status(502).json({
            error: {
              code: 'upstream_unavailable',
              message:
                'Koneksi ke bot terputus. Aksi mungkin sudah tersimpan; coba ulang dengan request yang sama.',
            },
          });
      } finally {
        res.off('close', onClose);
      }
    },
  );
  router.get('/', (_req, res) => {
    res.sendFile(path.join(assets, 'index.html'));
  });
  router.use(
    express.static(assets, {
      index: false,
      dotfiles: 'deny',
      fallthrough: true,
      etag: false,
      maxAge: 0,
    }),
  );
  return router;
}

export const rpgRouter = createRpgRouter({
  upstream: config.rpgUpstreamUrl,
  secret: config.rpgGatewaySecret,
});
