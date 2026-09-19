jest.mock('axios');
jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobStatusLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import axios from 'axios';
import supertest from 'supertest';
import app from '../app';
import {
  downloadBilibiliOpus,
  parseBilibiliDynamic,
  parseBilibiliOpus,
} from '../modules/bilibili/bilibili.opus';

const get = axios.get as jest.MockedFunction<typeof axios.get>;
const id = '1247969693541597185';
const headers = { Referer: 'https://www.bilibili.com/', 'User-Agent': 'fixture' };
const pics = [
  { url: 'http://i0.hdslb.com/bfs/new_dyn/first.png', width: 2880, height: 3840 },
  { url: '//i0.hdslb.com/bfs/new_dyn/second.jpg', width: 3840, height: 2880 },
  { url: 'https://i0.hdslb.com/bfs/new_dyn/third.png@264w_264h_1e_1c', width: 2880, height: 3840 },
];
function fixture(pictures = pics, postId = id) {
  return {
    detail: {
      id_str: postId,
      basic: { title: 'Author post', is_only_fans: false },
      modules: [
        {
          module_author: {
            mid: 210752,
            name: 'Author',
            face: 'https://i0.hdslb.com/bfs/face/avatar.jpg',
            pub_ts: '1789403987',
          },
        },
        {
          module_content: {
            paragraphs: [
              {
                text: {
                  nodes: [
                    { word: { words: 'Hey？ {braces} "quotes" \\ path' }, rich: null },
                    {
                      rich: {
                        text: '[emoji]',
                        emoji: { icon_url: 'https://i0.hdslb.com/bfs/emote/emoji.png' },
                      },
                    },
                  ],
                },
              },
              { pic: { pics: pictures } },
            ],
          },
        },
      ],
    },
  };
}
function html(state: unknown) {
  return `<html><img src="https://i0.hdslb.com/bfs/face/avatar.jpg"><script>window.__INITIAL_STATE__=${JSON.stringify(state)};globalThis.opusScriptExecuted = true;</script></html>`;
}

function apiFixture(postId = id) {
  return {
    code: 0,
    data: {
      item: {
        id_str: postId,
        visible: true,
        modules: {
          module_author: fixture().detail.modules[0].module_author,
          module_dynamic: {
            desc: { text: 'Post description' },
            major: {
              type: 'MAJOR_TYPE_DRAW',
              draw: {
                items: pics.map(({ url, ...size }) => ({ src: url, ...size })),
              },
            },
          },
        },
      },
    },
  };
}

describe('Bilibili Opus', () => {
  beforeEach(() => get.mockReset());

  it('returns original images in post order and retains the large ID as a string', async () => {
    get.mockResolvedValueOnce({ status: 200, data: html(fixture()), headers: {} });
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url: `https://www.bilibili.com/opus/${id}?spm_id_from=333.1387.0.0` });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id,
      format: 'images',
      requiresMerge: false,
      uploaded: 1789403987,
    });
    expect(response.body.data.description).toBe('Hey？ {braces} "quotes" \\ path[emoji]');
    expect(response.body.data.media.map((item: { url: string }) => item.url)).toEqual([
      'https://i0.hdslb.com/bfs/new_dyn/first.png',
      'https://i0.hdslb.com/bfs/new_dyn/second.jpg',
      'https://i0.hdslb.com/bfs/new_dyn/third.png',
    ]);
    expect(response.body.data.media[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      width: 2880,
      height: 3840,
      order: 1,
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(`https://www.bilibili.com/opus/${id}`);
    expect(get.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
    expect(globalThis).not.toHaveProperty('opusScriptExecuted');
  });

  it('preserves a GIF instead of using its thumbnail or treating it as a video', () => {
    const gifId = '1000310312918843446';
    const result = parseBilibiliOpus(
      html(
        fixture(
          [{ url: 'http://i0.hdslb.com/bfs/new_dyn/animation.gif', width: 400, height: 400 }],
          gifId,
        ),
      ),
      gifId,
      headers,
    );
    expect(result.media).toHaveLength(1);
    expect(result.media[0]).toMatchObject({
      type: 'gif',
      mimeType: 'image/gif',
      url: 'https://i0.hdslb.com/bfs/new_dyn/animation.gif',
    });
  });

  it('deduplicates repeated original image URLs', () => {
    const result = parseBilibiliOpus(html(fixture([pics[0], pics[0], pics[1]])), id, headers);
    expect(result.media).toHaveLength(2);
    expect(result.media[1].order).toBe(2);
  });

  it('resolves short links to Opus through the same command', async () => {
    const url = `https://www.bilibili.com/opus/${id}`;
    get.mockResolvedValueOnce({ status: 302, headers: { location: url }, data: '' });
    get.mockResolvedValueOnce({ status: 200, headers: {}, config: { url }, data: html(fixture()) });
    get.mockResolvedValueOnce({ status: 200, headers: {}, data: html(fixture()) });
    const response = await supertest(app)
      .get('/api/bilibili/download')
      .query({ url: 'https://b23.tv/opus-test' });
    expect(response.status).toBe(200);
    expect(response.body.data.format).toBe('images');
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.test/pic.png',
    'https://hdslb.com.evil.test/bfs/pic.png',
    'https://user:pass@i0.hdslb.com/bfs/pic.png',
    'https://i0.hdslb.com:8080/bfs/pic.png',
    'https://i0.hdslb.com/bfs/image.svg',
  ])('rejects unsupported image URLs: %s', (url) => {
    expect(() =>
      parseBilibiliOpus(html(fixture([{ url, width: 1, height: 1 }])), id, headers),
    ).toThrow();
  });

  it('rejects removed or empty Opus posts', async () => {
    get.mockResolvedValueOnce({ status: 200, data: html(fixture([])), headers: {} });
    expect(
      (
        await supertest(app)
          .get('/api/bilibili')
          .query({ url: `https://www.bilibili.com/opus/${id}` })
      ).status,
    ).toBe(404);
  });

  it('rejects restricted posts', () => {
    const state = fixture();
    state.detail.basic.is_only_fans = true;
    expect(() => parseBilibiliOpus(html(state), id, headers)).toThrow('restricted');
  });

  it('rejects mismatched post IDs', () => {
    expect(() => parseBilibiliOpus(html(fixture()), '1000310312918843446', headers)).toThrow(
      'details',
    );
  });

  it.each([
    '<html>blocked</html>',
    '<script>window.__INITIAL_STATE__={bad}</script>',
    '<script>window.__INITIAL_STATE__={"detail":',
  ])('rejects malformed page state', (page) => {
    expect(() => parseBilibiliOpus(page, id, headers)).toThrow();
  });

  it('rejects video-only page selection for Opus before fetching', async () => {
    expect(
      (
        await supertest(app)
          .get('/api/bilibili')
          .query({ url: `https://www.bilibili.com/opus/${id}`, page: '2' })
      ).status,
    ).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not expose upstream request details on failure', async () => {
    get.mockRejectedValueOnce(new Error('Cookie=secret'));
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url: `https://www.bilibili.com/opus/${id}` });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('falls back to the detail API when HTTP 200 contains a CAPTCHA page', async () => {
    get.mockResolvedValueOnce({
      status: 200,
      data: '<html><title>验证码_哔哩哔哩</title><div id="risk-captcha-app"></div></html>',
      headers: {},
    });
    get.mockResolvedValueOnce({ status: 200, data: apiFixture(), headers: {} });
    const response = await supertest(app)
      .get('/api/bilibili')
      .query({ url: `https://www.bilibili.com/opus/${id}` });
    expect(response.status).toBe(200);
    expect(response.body.data.description).toBe('Post description');
    expect(response.body.data.media).toHaveLength(3);
    expect(response.body.data.media[2].url).toBe('https://i0.hdslb.com/bfs/new_dyn/third.png');
    expect(get.mock.calls[1][0]).toBe(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}`,
    );
  });

  it('uses the configured cookie only for the API request and never returns it', async () => {
    const previous = process.env.BILIBILI_SESSDATA;
    process.env.BILIBILI_SESSDATA = 'secret%2Ccookie';
    try {
      get.mockRejectedValueOnce(new Error('HTTP 412'));
      get.mockResolvedValueOnce({ status: 200, data: apiFixture(), headers: {} });
      const result = await downloadBilibiliOpus(id, headers);
      expect(get.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie');
      expect(get.mock.calls[1][1]?.headers).toHaveProperty('Cookie', 'SESSDATA=secret%2Ccookie');
      expect(JSON.stringify(result)).not.toContain('secret');
    } finally {
      if (previous === undefined) delete process.env.BILIBILI_SESSDATA;
      else process.env.BILIBILI_SESSDATA = previous;
    }
  });

  it('does not fall back for explicitly restricted HTML posts', async () => {
    const state = fixture();
    state.detail.basic.is_only_fans = true;
    get.mockResolvedValueOnce({ status: 200, data: html(state), headers: {} });
    await expect(downloadBilibiliOpus(id, headers)).rejects.toMatchObject({ statusCode: 403 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([-352, -412, -101, -404, 62002])(
    'reports detail API error code %s accurately',
    (code) => {
      try {
        parseBilibiliDynamic({ code }, id, headers);
        throw new Error('Expected API error');
      } catch (error) {
        expect(error).toMatchObject({ statusCode: [-404, 62002].includes(code) ? 404 : 502 });
      }
    },
  );

  it('rejects restricted, malformed, mismatched, and unsafe API data', () => {
    const restricted = apiFixture();
    restricted.data.item.visible = false;
    expect(() => parseBilibiliDynamic(restricted, id, headers)).toThrow('restricted');
    expect(() => parseBilibiliDynamic(apiFixture('123'), id, headers)).toThrow('details');
    expect(() => parseBilibiliDynamic({ code: 0, data: {} }, id, headers)).toThrow('details');
    const unsafe = apiFixture();
    unsafe.data.item.modules.module_dynamic.major.draw.items[0].src = 'https://evil.test/pic.png';
    expect(() => parseBilibiliDynamic(unsafe, id, headers)).toThrow('Unsupported');
  });

  it('supports the Opus API layout and retains original GIFs', () => {
    const data = apiFixture().data;
    const result = parseBilibiliDynamic(
      {
        code: 0,
        data: {
          item: {
            ...data.item,
            modules: {
              ...data.item.modules,
              module_dynamic: {
                desc: null,
                major: {
                  type: 'MAJOR_TYPE_OPUS',
                  opus: {
                    title: 'Opus title',
                    summary: { text: 'Summary' },
                    pics: [
                      {
                        url: 'https://i0.hdslb.com/bfs/new_dyn/image.gif',
                        width: 400,
                        height: 300,
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      id,
      headers,
    );
    expect(result).toMatchObject({ title: 'Opus title', description: 'Summary' });
    expect(result.media[0]).toMatchObject({ type: 'gif', width: 400, height: 300 });
  });
});
