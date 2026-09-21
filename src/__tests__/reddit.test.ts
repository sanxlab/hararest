import axios from 'axios';
import * as dns from 'dns/promises';
import supertest from 'supertest';
import app from '../app';
import { RedditService } from '../modules/reddit/reddit.service';
import { parseRedditDash } from '../modules/reddit/reddit.dash';

jest.mock('axios');
jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobStatusLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const lookup = dns.lookup as jest.Mock;
const service = new RedditService({});
const short = 'https://www.reddit.com/r/Kucing/s/zd1rVlyJGL';
const canonical = 'https://www.reddit.com/r/Kucing/comments/1wiqwa0/is_this_behavior_normal/';
const fixture = (extra: Record<string, unknown> = {}) => [
  {
    data: {
      children: [
        {
          kind: 't3',
          data: {
            id: '1wiqwa0',
            title: 'Kucing',
            author: 'cat-owner',
            url: 'https://i.redd.it/cat.jpg',
            ...extra,
          },
        },
      ],
    },
  },
];
const reply = (data: unknown, status = 200) => ({ status, data, headers: {} });
const dash = `<MPD><Period><AdaptationSet contentType="video" mimeType="video/mp4"><Representation height="480"><BaseURL>DASH_480.mp4?source=fallback&amp;x=1</BaseURL></Representation><Representation height="720"><BaseURL>DASH_720.mp4</BaseURL></Representation></AdaptationSet><AdaptationSet mimeType="audio/mp4"><Representation bandwidth="64000"><BaseURL>DASH_AUDIO_64.mp4</BaseURL></Representation><Representation bandwidth="128000"><BaseURL>DASH_AUDIO_128.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
const video = (extra = {}) =>
  fixture({
    url: 'https://v.redd.it/videoid',
    secure_media: {
      reddit_video: {
        fallback_url: 'https://v.redd.it/videoid/DASH_720.mp4',
        dash_url: 'https://v.redd.it/videoid/DASHPlaylist.mpd',
        height: 720,
        duration: 10,
        is_gif: false,
        ...extra,
      },
    },
  });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  get.mockResolvedValue(reply(fixture()));
});
it.each(['/api/reddit', '/api/reddit/download'])(
  'returns direct image URLs through %s',
  async (route) => {
    get.mockResolvedValueOnce({ status: 302, headers: { location: `${canonical}?share_id=test` } });
    const response = await supertest(app).get(route).query({ url: short });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      source_url: short,
      resolved_url: canonical,
      provider: 'reddit',
      count: 1,
      download_url: 'https://i.redd.it/cat.jpg',
      requires_conversion: false,
      is_gallery: false,
    });
    expect(response.body.data.media[0]).toMatchObject({
      type: 'image',
      format: 'jpg',
      quality: 'original',
      audio_url: null,
    });
    expect(get.mock.calls[1][0]).toBe('https://www.reddit.com/comments/1wiqwa0.json');
    expect(post).not.toHaveBeenCalled();
  },
);
it.each([
  [undefined, 400],
  ['', 400],
  ['invalid', 400],
  ['https://example.com/post', 403],
  ['https://reddit.com.evil.test/comments/abc', 403],
  ['https://evil.reddit.com/comments/abc', 403],
  ['ftp://reddit.com/comments/abc', 400],
  ['https://user:pass@reddit.com/comments/abc', 400],
  ['https://reddit.com:8443/comments/abc', 400],
  ['https://www.reddit.com/r/Kucing/', 400],
])('rejects invalid URL %s without fetching', async (url, status) => {
  expect(
    (
      await supertest(app)
        .get('/api/reddit')
        .query(url === undefined ? {} : { url })
    ).status,
  ).toBe(status);
  expect(get).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});
it('rejects repeated query parameters', async () => {
  expect((await supertest(app).get('/api/reddit?url=a&url=b')).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});
it.each(['https://redd.it/1wiqwa0', 'https://www.reddit.com/gallery/1wiqwa0'])(
  'extracts the post ID from %s',
  async (url) => {
    await service.download(url);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('https://www.reddit.com/comments/1wiqwa0.json');
  },
);
it('follows a relative share redirect', async () => {
  get.mockResolvedValueOnce({
    status: 301,
    headers: { location: '/r/Kucing/comments/1wiqwa0/is_this_behavior_normal/' },
  });
  expect((await service.download(short)).resolved_url).toBe(canonical);
});
it.each([
  'https://127.0.0.1/private',
  'https://evil.test/comments/abc',
  'https://user:secret@www.reddit.com/comments/abc',
])('rejects unsafe redirect %s', async (location) => {
  get.mockResolvedValue({ status: 302, headers: { location } });
  await expect(service.download(short)).rejects.toHaveProperty('statusCode');
  expect(get).toHaveBeenCalledTimes(1);
});
it('bounds redirect loops', async () => {
  get.mockResolvedValue({ status: 302, headers: { location: short } });
  await expect(service.download(short)).rejects.toThrow('Too many');
  expect(get).toHaveBeenCalledTimes(6);
});
it('preserves gallery order, animated items, full resolution, and decoded query strings', async () => {
  get.mockResolvedValue(
    reply(
      fixture({
        url: '',
        gallery_data: {
          items: [{ media_id: 'b' }, { media_id: 'a' }, { media_id: 'bad' }, { media_id: 'b' }],
        },
        media_metadata: {
          a: {
            status: 'valid',
            e: 'Image',
            m: 'image/png',
            s: { u: 'https://i.redd.it/a.png?x=1&amp;y=2' },
            p: [{ u: 'https://i.redd.it/thumb.png' }],
          },
          b: {
            status: 'valid',
            e: 'AnimatedImage',
            s: { mp4: 'https://preview.redd.it/b.gif?format=mp4', gif: 'https://i.redd.it/b.gif' },
          },
          bad: { status: 'failed' },
        },
      }),
    ),
  );
  const result = await service.download(canonical);
  expect(result.is_gallery).toBe(true);
  expect(result.count).toBe(2);
  expect(result.media[0]).toMatchObject({ is_gif: true, type: 'video', format: 'mp4' });
  expect(result.media[1].url).toBe('https://i.redd.it/a.png?x=1&y=2');
});
it('extracts media from crossposts while retaining the requested title', async () => {
  get.mockResolvedValue(
    reply(
      fixture({
        url: 'https://www.reddit.com/comments/parent/',
        crosspost_parent_list: [{ url: 'https://i.redd.it/parent.webp' }],
      }),
    ),
  );
  const result = await service.download(canonical);
  expect(result.title).toBe('Kucing');
  expect(result.media[0].format).toBe('webp');
});
it('pairs video qualities with the best audio without claiming the video URL has audio', async () => {
  get.mockResolvedValueOnce(reply(video())).mockResolvedValueOnce(reply(dash));
  const result = await service.download(canonical);
  expect(result.duration).toBe(10);
  expect(result.count).toBe(2);
  expect(result.media.map((item) => item.quality_number)).toEqual([720, 480]);
  expect(result.media[0]).toMatchObject({
    audio_url: 'https://v.redd.it/videoid/DASH_AUDIO_128.mp4',
    has_audio: false,
    requires_conversion: false,
  });
  expect(result.media[1].url).toContain('source=fallback&x=1');
});
it('keeps silent GIFs silent and falls back honestly when DASH cannot be loaded', async () => {
  get.mockResolvedValueOnce(reply(video({ is_gif: true }))).mockResolvedValueOnce(reply(dash));
  expect(
    (await service.download(canonical)).media.every((item) => item.is_gif && !item.audio_url),
  ).toBe(true);
  get
    .mockResolvedValueOnce(reply(video()))
    .mockRejectedValueOnce(new Error('private request details'));
  expect((await service.download(canonical)).media[0]).toMatchObject({
    has_audio: false,
    audio_url: null,
  });
});
it('never fetches a private manifest address', async () => {
  get.mockResolvedValue(reply(video()));
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await service.download(canonical);
  expect(get).toHaveBeenCalledTimes(1);
});
it('ignores unsafe or segmented DASH representations', () => {
  const xml =
    '<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><BaseURL>http://127.0.0.1/a.mp4</BaseURL></Representation><Representation><BaseURL>https://evil.test/a.mp4</BaseURL></Representation><Representation><SegmentTemplate/><BaseURL>https://v.redd.it/a/video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
  expect(parseRedditDash(xml, 'https://v.redd.it/a/DASHPlaylist.mpd', false)).toEqual([]);
});
it.each([403, 429, 404, 500])('handles Reddit HTTP %s with a useful error', async (status) => {
  get.mockResolvedValue(reply({}, status));
  await expect(service.download(canonical)).rejects.toMatchObject({
    statusCode: status === 404 ? 404 : status === 500 ? 502 : 503,
  });
});
it.each(['<html>blocked</html>', {}, [{ data: { children: [] } }]])(
  'rejects unavailable or malformed post data',
  async (body) => {
    get.mockResolvedValue(reply(body));
    await expect(service.download(canonical)).rejects.toHaveProperty('statusCode');
  },
);
it.each([
  'https://evil.test/photo.jpg',
  'https://i.redd.it.evil.test/photo.jpg',
  'https://user:password@i.redd.it/photo.jpg',
  'file:///etc/passwd',
  'https://example.com/article',
])('does not turn external links into downloads: %s', async (url) => {
  get.mockResolvedValue(reply(fixture({ url, thumbnail: 'https://i.redd.it/thumbnail.jpg' })));
  await expect(service.download(canonical)).rejects.toMatchObject({ statusCode: 404 });
});
it('does not expose request details', async () => {
  get.mockRejectedValue(new Error('secret request data'));
  const response = await supertest(app).get('/api/reddit').query({ url: canonical });
  expect(response.status).toBe(502);
  expect(JSON.stringify(response.body)).not.toContain('secret');
});
it('uses only configured OAuth credentials and caches the token', async () => {
  const oauth = new RedditService({
    clientId: 'app-id',
    clientSecret: 'app-secret',
    userAgent: 'test-agent',
  });
  post.mockResolvedValue(reply({ access_token: 'test-token', expires_in: 3600 }));
  await oauth.download(canonical);
  await oauth.download(canonical);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]).toEqual([
    'https://www.reddit.com/api/v1/access_token',
    'grant_type=client_credentials',
    expect.objectContaining({
      maxRedirects: 0,
      auth: { username: 'app-id', password: 'app-secret' },
    }),
  ]);
  expect(get.mock.calls[0][0]).toBe('https://oauth.reddit.com/comments/1wiqwa0.json');
  expect(get.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
});
it('refreshes a rejected OAuth token once and does not send it to the media CDN', async () => {
  const oauth = new RedditService({ clientId: 'id', clientSecret: 'secret' });
  post.mockResolvedValue(reply({ access_token: 'token', expires_in: 3600 }));
  get
    .mockResolvedValueOnce(reply({}, 401))
    .mockResolvedValueOnce(reply(video()))
    .mockResolvedValueOnce(reply(dash));
  await oauth.download(canonical);
  expect(post).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[2][1].headers).not.toHaveProperty('Authorization');
});
it('does not leak failed OAuth credentials', async () => {
  const oauth = new RedditService({ clientId: 'id', clientSecret: 'secret' });
  post.mockRejectedValue(new Error('secret'));
  await expect(oauth.download(canonical)).rejects.toThrow('Reddit authentication failed');
  expect(get).not.toHaveBeenCalled();
});
