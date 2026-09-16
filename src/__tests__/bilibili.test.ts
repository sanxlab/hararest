jest.mock('axios');
jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobStatusLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import axios from 'axios';
import supertest from 'supertest';
import app from '../app';

const get = axios.get as jest.MockedFunction<typeof axios.get>;
const url = 'https://www.bilibili.com/video/BV1Ak8Q6hECg/?share_source=copy_web&vd_source=example';
const info = {
  bvid: 'BV1Ak8Q6hECg',
  aid: 117159778918369,
  title: '知更鸟',
  desc: 'Description',
  pic: 'https://i1.hdslb.com/cover.jpg',
  pubdate: 1787717055,
  owner: { mid: 210752, name: 'Author', face: 'https://i1.hdslb.com/avatar.jpg' },
  pages: [
    { cid: 41274311130, page: 1, part: 'Part 1', duration: 124 },
    { cid: 41274311131, page: 2, part: 'Part 2', duration: 60 },
  ],
};
const play = {
  quality: 64,
  accept_quality: [80, 64, 32],
  accept_description: ['1080P', '720P', '480P'],
  dash: {
    video: [
      {
        id: 32,
        base_url: 'https://cdn.bilivideo.com/480.m4s',
        mime_type: 'video/mp4',
        width: 852,
        height: 480,
        bandwidth: 600000,
        codecs: 'avc1',
      },
      {
        id: 64,
        baseUrl: 'https://cdn.bilivideo.com/720.m4s',
        mimeType: 'video/mp4',
        width: 1280,
        height: 720,
        bandwidth: 1200000,
        backupUrl: ['https://cdn.bilivideo.com/backup.m4s'],
      },
    ],
    audio: [
      {
        id: 30280,
        base_url: 'https://cdn.bilivideo.com/audio.m4s',
        mime_type: 'audio/mp4',
        bandwidth: 192000,
      },
    ],
  },
};
function reply(data: unknown) {
  get.mockResolvedValueOnce({ status: 200, headers: {}, data: { code: 0, data } });
}

describe('Bilibili scraper', () => {
  const originalCookie = process.env.BILIBILI_SESSDATA;
  beforeEach(() => {
    get.mockReset();
    delete process.env.BILIBILI_SESSDATA;
  });
  afterAll(() => {
    if (originalCookie === undefined) delete process.env.BILIBILI_SESSDATA;
    else process.env.BILIBILI_SESSDATA = originalCookie;
  });

  it('returns metadata and actual DASH qualities without claiming unavailable HD', async () => {
    reply(info);
    reply(play);
    const response = await supertest(app).get('/api/bilibili').query({ url });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      data: {
        id: info.bvid,
        title: info.title,
        cid: info.pages[0].cid,
        duration: 124,
        format: 'dash',
        requiresMerge: true,
        availableQualities: [64, 32],
        requestedQuality: 80,
        headers: { Referer: 'https://www.bilibili.com/' },
      },
    });
    expect(response.body.data.media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'video',
          quality: 64,
          height: 720,
          backupUrls: ['https://cdn.bilivideo.com/backup.m4s'],
        }),
        expect.objectContaining({
          type: 'audio',
          mimeType: 'audio/mp4',
          url: 'https://cdn.bilivideo.com/audio.m4s',
        }),
      ]),
    );
    expect(get).toHaveBeenNthCalledWith(
      1,
      'https://api.bilibili.com/x/web-interface/wbi/view',
      expect.objectContaining({
        params: { bvid: info.bvid },
        maxRedirects: 0,
        proxy: false,
        timeout: 15000,
      }),
    );
  });

  it.each([
    [{ url: `${url}&p=2`, quality: '720p' }, 64],
    [{ url: `${url}&p=1`, page: '2', quality: '4k' }, 120],
  ])('selects the requested part and quality: %j', async (query, qn) => {
    reply(info);
    reply(play);
    const response = await supertest(app).get('/api/bilibili/download').query(query);
    expect(response.status).toBe(200);
    expect(response.body.data.page).toBe(2);
    expect(response.body.data.duration).toBe(60);
    expect(get).toHaveBeenLastCalledWith(
      'https://api.bilibili.com/x/player/playurl',
      expect.objectContaining({
        params: { bvid: info.bvid, cid: info.pages[1].cid, qn, fnval: 4048, fourk: 1 },
      }),
    );
  });

  it('accepts av IDs', async () => {
    reply(info);
    reply(play);
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url: 'https://www.bilibili.com/video/av117159778918369/' });
    expect(response.status).toBe(200);
    expect(get.mock.calls[0][1]?.params).toEqual({ aid: '117159778918369' });
  });

  it.each([
    ['test,secret/part+token=', 'test%2Csecret%2Fpart%2Btoken%3D'],
    ['test%2Csecret%2Fpart%2Btoken%3D', 'test%2Csecret%2Fpart%2Btoken%3D'],
    ['  test%2csecret%2fpart%2btoken%3d  ', 'test%2Csecret%2Fpart%2Btoken%3D'],
    ['test%raw', 'test%25raw'],
  ])('normalizes raw and browser-encoded login cookies: case %#', async (cookie, encoded) => {
    process.env.BILIBILI_SESSDATA = cookie;
    reply(info);
    reply(play);
    const response = await supertest(app).get('/api/bilibili').query({ url });
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
    for (const [, options] of get.mock.calls) {
      expect(options?.headers).toHaveProperty('Cookie', `SESSDATA=${encoded}`);
    }
    expect(response.body.data.headers).not.toHaveProperty('Cookie');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('resolves short links through validated redirects without forwarding the login cookie', async () => {
    process.env.BILIBILI_SESSDATA = 'test,secret';
    get.mockResolvedValueOnce({ status: 302, headers: { location: url }, data: '' });
    get.mockResolvedValueOnce({ status: 200, headers: {}, config: { url }, data: '<html></html>' });
    reply(info);
    reply(play);
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url: 'https://b23.tv/abc123' });
    expect(response.status).toBe(200);
    expect(get.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
    expect(get.mock.calls[2][1]?.headers).toHaveProperty('Cookie', 'SESSDATA=test%2Csecret');
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(response.body.data.headers).not.toHaveProperty('Cookie');
  });

  it.each(['http://127.0.0.1/private', 'https://example.com/video/BV1Ak8Q6hECg/'])(
    'rejects unsafe short-link redirects: %s',
    async (location) => {
      get.mockResolvedValueOnce({ status: 302, headers: { location }, data: '' });
      const response = await supertest(app)
        .get('/api/bilibili')
        .query({ url: 'https://b23.tv/abc123' });
      expect(response.status).toBe(403);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {},
    { url, quality: 'bad' },
    { url, quality: '__proto__' },
    { url, page: '0' },
    { url, page: '1.5' },
    { url, page: 'abc' },
    { url: `${url}&p=0` },
    { url: `${url}&p=1&p=2` },
    { url: 'https://www.bilibili.com/video/BVbad' },
    { url: 'https://www.bilibili.com/bangumi/play/ep123' },
    { url: 'https://live.bilibili.com/123' },
    { url: 'https://user:pass@www.bilibili.com/video/BV1Ak8Q6hECg/' },
    { url: 'https://www.bilibili.com:8080/video/BV1Ak8Q6hECg/' },
  ])('rejects invalid input before contacting upstream: %j', async (query) => {
    expect((await supertest(app).get('/api/bilibili').query(query)).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects duplicate query parameters', async () => {
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url, quality: ['720p', '1080p'] });
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects lookalike domains', async () => {
    expect(
      (
        await supertest(app)
          .get('/api/bilibili')
          .query({ url: 'https://bilibili.com.evil.test/video/BV1Ak8Q6hECg/' })
      ).status,
    ).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects nonexistent parts', async () => {
    reply(info);
    expect((await supertest(app).get('/api/bilibili').query({ url, page: '3' })).status).toBe(400);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back when the primary metadata endpoint is blocked', async () => {
    get.mockRejectedValueOnce(new Error('HTTP 412'));
    reply(info);
    reply(play);
    expect((await supertest(app).get('/api/bilibili').query({ url })).status).toBe(200);
    expect(get.mock.calls[1][0]).toBe('https://api.bilibili.com/x/web-interface/view');
  });

  it('falls back when playback reports a risk-control code', async () => {
    reply(info);
    get.mockResolvedValueOnce({ data: { code: -352 } });
    reply(play);
    expect((await supertest(app).get('/api/bilibili').query({ url })).status).toBe(200);
    expect(get.mock.calls[2][0]).toBe('https://api.bilibili.com/x/player/wbi/playurl');
  });

  it('retains all progressive segments in playback order', async () => {
    reply(info);
    reply({
      quality: 32,
      format: 'flv480',
      durl: [
        { order: 2, url: 'https://cdn.bilivideo.com/2.flv', size: 200, length: 30000 },
        {
          order: 1,
          url: 'https://cdn.bilivideo.com/1.flv',
          size: 100,
          length: 94000,
          backup_url: null,
        },
      ],
    });
    const response = await supertest(app).get('/api/bilibili').query({ url });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      format: 'progressive',
      requiresMerge: true,
      availableQualities: [32],
    });
    expect(response.body.data.media.map((item: { order: number }) => item.order)).toEqual([1, 2]);
    expect(response.body.data.media[0]).toMatchObject({
      type: 'muxed',
      size: 100,
      duration: 94,
      mimeType: 'video/x-flv',
    });
  });

  it('returns a single progressive MP4 without a merge requirement', async () => {
    reply(info);
    reply({
      quality: 16,
      format: 'mp4',
      dash: null,
      durl: [{ order: 1, url: 'https://cdn.bilivideo.com/video.mp4' }],
    });
    const response = await supertest(app).get('/api/bilibili').query({ url });
    expect(response.status).toBe(200);
    expect(response.body.data.requiresMerge).toBe(false);
    expect(response.body.data.media[0].mimeType).toBe('video/mp4');
  });

  it.each([
    { quality: 80, dash: { video: [], audio: null } },
    { quality: 80, dash: { video: [{ id: 80, base_url: 'javascript:alert(1)' }] } },
    { quality: 80, durl: [{ order: 1, url: 'file:///etc/passwd' }] },
    { quality: 80, dash: 'invalid' },
  ])('rejects empty or malformed playback responses: %j', async (data) => {
    reply(info);
    reply(data);
    expect((await supertest(app).get('/api/bilibili').query({ url })).status).toBe(502);
  });

  it.each([
    [-404, 404],
    [-101, 502],
    [-400, 502],
  ])('maps upstream code %s to HTTP %s', async (code, status) => {
    get.mockResolvedValueOnce({ data: { code } });
    expect((await supertest(app).get('/api/bilibili').query({ url })).status).toBe(status);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reports network failure without leaking request credentials', async () => {
    get.mockRejectedValue(new Error('Request failed with Cookie=secret'));
    const response = await supertest(app).get('/api/bilibili').query({ url });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('reports invalid upstream HTML as 502', async () => {
    get.mockResolvedValueOnce({ data: '<html>blocked</html>' });
    expect((await supertest(app).get('/api/bilibili').query({ url })).status).toBe(502);
  });
});
