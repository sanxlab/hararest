import axios from 'axios';
import supertest from 'supertest';
import app from '../app';
import { RedditService } from '../modules/reddit/reddit.service';

jest.mock('axios');
jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobStatusLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const service = new RedditService();
const short = 'https://www.reddit.com/r/Kucing/s/zd1rVlyJGL';
const canonical = 'https://www.reddit.com/r/Kucing/comments/1wiqwa0/is_this_behavior_normal/';
const fixture = () => ({
  url: [
    {
      url: 'https://du.sf-converter.com/convert?payload=720',
      ext: 'mp4',
      quality: '720x1280',
      qualityNumber: 720,
      isConverterUI: true,
    },
    {
      url: 'https://du.sf-converter.com/convert?payload=1080',
      ext: 'mp4',
      quality: '1080x1920',
      qualityNumber: 1080,
      isConverterUI: true,
    },
  ],
  meta: { title: 'Is this behavior normal?', uploader: 'Great-Big6159', duration: '10' },
  thumb: 'https://external-preview.redd.it/preview.jpeg',
});
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ status: 301, headers: { location: `${canonical}?share_id=test` } });
  post.mockResolvedValue({ data: fixture() });
});
it.each(['/api/reddit', '/api/reddit/download'])(
  'resolves share URLs through %s',
  async (route) => {
    const result = await supertest(app).get(route).query({ url: short });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'success',
      data: {
        source_url: short,
        resolved_url: canonical,
        provider: 'savefrom.co.id',
        title: 'Is this behavior normal?',
        duration: 10,
        count: 2,
        requires_conversion: true,
        download_url: 'https://du.sf-converter.com/convert?payload=1080',
      },
    });
    expect(result.body.data.media[0]).toMatchObject({
      quality_number: 1080,
      type: 'video',
      has_audio: null,
    });
    expect(get).toHaveBeenCalledTimes(1);
    const [endpoint, body, config] = post.mock.calls[0];
    expect(endpoint).toBe('https://api-wh.savefrom.co.id/api/convert');
    expect(new URLSearchParams(body).get('sf_url')).toBe(canonical);
    expect(config).toMatchObject({ maxRedirects: 0, timeout: 20000, proxy: false });
  },
);
it('matches a recorded browser signature for the canonical URL', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1789834396569);
  try {
    await service.download(canonical);
    const fields = new URLSearchParams(post.mock.calls[0][1]);
    expect(fields.get('_ts')).toBe('1789035341806');
    expect(fields.get('ts')).toBe('1789834396569');
    expect(fields.get('_s')).toBe(
      '43b6a1c0e9ed307645badd51c5aa2301e883a77451669f35d1d72c6420f9e1e8',
    );
    expect(get).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});
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
  const response = await supertest(app)
    .get('/api/reddit')
    .query(url === undefined ? {} : { url });
  expect(response.status).toBe(status);
  expect(get).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});
it('rejects repeated query parameters', async () => {
  expect((await supertest(app).get('/api/reddit?url=a&url=b')).status).toBe(400);
  expect(post).not.toHaveBeenCalled();
});
it('resolves redd.it and relative redirects', async () => {
  get.mockResolvedValueOnce({ status: 302, headers: { location: short } });
  get.mockResolvedValueOnce({
    status: 301,
    headers: { location: '/r/Kucing/comments/1wiqwa0/is_this_behavior_normal/' },
  });
  expect((await service.download('https://redd.it/1wiqwa0')).resolved_url).toBe(canonical);
});
it.each([
  'https://127.0.0.1/private',
  'https://evil.test/comments/abc',
  'https://user:secret@www.reddit.com/comments/abc',
])('rejects unsafe redirects to %s', async (location) => {
  get.mockResolvedValue({ status: 302, headers: { location } });
  await expect(service.download(short)).rejects.toHaveProperty('statusCode');
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});
it('bounds redirect loops and handles blocked pages', async () => {
  get.mockResolvedValue({ status: 302, headers: { location: short } });
  await expect(service.download(short)).rejects.toThrow('Too many');
  expect(get).toHaveBeenCalledTimes(6);
  get.mockResolvedValue({ status: 403, headers: {}, data: 'Blocked' });
  await expect(service.download(short)).rejects.toMatchObject({ statusCode: 502 });
});
it('does not expose internal request errors', async () => {
  post.mockRejectedValue(new Error('secret request data'));
  const result = await supertest(app).get('/api/reddit').query({ url: canonical });
  expect(result.status).toBe(502);
  expect(JSON.stringify(result.body)).not.toContain('secret');
});
it.each([
  [{ success: false, response: 4 }, 404],
  [{ success: false, response: 9 }, 502],
  [{ info: -1, code: 'globalThis.executed = true' }, 502],
  ['<html>blocked</html>', 502],
  [{ url: [] }, 404],
])('handles provider failures safely', async (body, status) => {
  post.mockResolvedValue({ data: body });
  await expect(service.download(canonical)).rejects.toMatchObject({ statusCode: status });
  expect(globalThis).not.toHaveProperty('executed');
});
it('filters unsafe URLs, deduplicates media, and distinguishes direct streams', async () => {
  post.mockResolvedValue({
    data: {
      url: [
        { url: 'javascript:alert(1)', ext: 'mp4' },
        { url: 'https://127.0.0.1/file.mp4', ext: 'mp4' },
        { url: 'https://user:pass@v.redd.it/a/file.mp4', ext: 'mp4' },
        { url: 'https://v.redd.it/a/video.mp4', ext: 'mp4', no_audio: true },
        { url: 'https://v.redd.it/a/video.mp4', ext: 'mp4' },
        { url: 'https://v.redd.it/a/audio.m4a', ext: 'm4a' },
        { url: 'https://i.redd.it/image.jpg', ext: 'jpg' },
      ],
    },
  });
  const result = await service.download(canonical);
  expect(result.count).toBe(3);
  expect(result.media[0]).toMatchObject({
    type: 'video',
    has_audio: false,
    requires_conversion: false,
  });
  expect(result.media[1]).toMatchObject({ type: 'audio', has_audio: true });
  expect(result.media[2]).toMatchObject({ type: 'image', has_audio: false });
  expect(result.duration).toBeNull();
});
