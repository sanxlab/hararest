import { createServer, type Server } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { createRpgRouter } from '../modules/rpg/rpg.route';

let upstream: Server;
let base: string;
let seen: {
  path?: string;
  cookie?: string;
  secret?: string;
  csrf?: string;
  origin?: string;
  body?: unknown;
};
beforeEach(async () => {
  seen = {};
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    seen = {
      path: req.originalUrl,
      cookie: req.get('cookie'),
      secret: req.get('x-rpg-gateway'),
      csrf: req.get('x-csrf-token'),
      origin: req.get('origin'),
      body: req.body,
    };
    res.setHeader(
      'Set-Cookie',
      `__Secure-hara_rpg=${'a'.repeat(64)}; Path=/rpg/api; HttpOnly; Secure; SameSite=Lax`,
    );
    res.status(200).json({ profile: { shards: 1600 } });
  });
  upstream = createServer(app);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  if (!addr || typeof addr === 'string') throw new Error('No upstream');
  base = `http://127.0.0.1:${addr.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
function testApp(settings = { upstream: base, secret: 'trusted-server-secret'.repeat(2) }) {
  const app = express();
  app.use('/rpg', createRpgRouter(settings));
  return app;
}
it('forwards only the fixed RPG API and approved session headers', async () => {
  const result = await supertest(testApp())
    .post('/rpg/api/gacha/pulls')
    .set('Origin', 'https://game.example.com')
    .set('X-CSRF-Token', 'csrf')
    .set('X-RPG-Gateway', 'attacker-value')
    .set('Cookie', `unrelated=private; __Secure-hara_rpg=${'b'.repeat(64)}`)
    .send({ request_id: 'one-request', count: 10, banner_id: 'fajar-v1' });
  expect(result.status).toBe(200);
  expect(seen).toMatchObject({
    path: '/rpg/api/gacha/pulls',
    cookie: `__Secure-hara_rpg=${'b'.repeat(64)}`,
    secret: 'trusted-server-secret'.repeat(2),
    csrf: 'csrf',
    origin: 'https://game.example.com',
    body: { count: 10 },
  });
  expect(result.headers['set-cookie'][0]).toContain('HttpOnly');
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.headers['access-control-allow-origin']).toBeUndefined();
});
it.each([
  '/rpg/api/signup',
  '/rpg/api/profile?url=http://evil.example',
  '/rpg/api/battles/not-an-id/actions',
])('rejects unsupported paths without contacting the upstream: %s', async (path) => {
  expect((await supertest(testApp()).post(path).send({})).status).toBe(404);
  expect(seen).toEqual({});
});
it('keeps the gateway disabled until configured', async () => {
  const res = await supertest(testApp({ upstream: '', secret: '' })).get('/rpg/api/profile');
  expect(res.status).toBe(503);
  expect(seen).toEqual({});
});
it('serves the live client with a restrictive script policy and no cache', async () => {
  const app = testApp();
  const page = await supertest(app).get('/rpg/');
  expect(page.status).toBe(200);
  expect(page.text).toContain('id="login-screen"');
  expect(page.text).not.toContain('catalog.js');
  expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  expect(page.headers['referrer-policy']).toBe('no-referrer');
  const script = await supertest(app).get('/rpg/game.js');
  expect(script.status).toBe(200);
  expect(script.text).not.toContain('localStorage');
  expect(script.text).not.toContain('Math.random');
  const art = await supertest(app).get('/rpg/assets/v1/char_001.webp');
  expect(art.status).toBe(200);
  expect(art.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(art.headers['content-type']).toContain('image/webp');
  const newArt = await supertest(app).get('/rpg/assets/v2/char_060.webp');
  expect(newArt.status).toBe(200);
  expect(newArt.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  const index = await supertest(app).get('/rpg/assets/index.json');
  expect(index.status).toBe(200);
  expect(index.headers['cache-control']).toBe('no-store');
  expect(Object.keys(index.body.characters)).toHaveLength(60);
  expect(Object.keys(index.body.enemies)).toHaveLength(100);
  expect(Object.keys(index.body.arenas)).toHaveLength(10);
});
it('reports a stopped upstream as retryable without leaking connection details', async () => {
  const res = await supertest(
    testApp({ upstream: 'http://127.0.0.1:1', secret: 's'.repeat(32) }),
  ).get('/rpg/api/profile');
  expect(res.status).toBe(502);
  expect(res.body.error.code).toBe('upstream_unavailable');
  expect(res.text).not.toContain('127.0.0.1');
});

it.each(['/characters/awaken', '/equipment/enhance'])(
  'forwards advancement with session and CSRF: %s',
  async (path) => {
    const body = {
      request_id: 'upgrade-request',
      expected_revision: 4,
      character_id: 'char_001',
      item_id: 'blade_dawn',
    };
    const res = await supertest(testApp())
      .post('/rpg/api' + path)
      .set('Origin', 'http://100.89.85.96:1338')
      .set('X-CSRF-Token', 'csrf-token')
      .set('Cookie', `hara_rpg_local=${'c'.repeat(64)}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(seen).toMatchObject({
      path: '/rpg/api' + path,
      csrf: 'csrf-token',
      body,
      cookie: `hara_rpg_local=${'c'.repeat(64)}`,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  },
);
