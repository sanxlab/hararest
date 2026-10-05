import axios from 'axios';
import { publicHttpAgent, publicHttpsAgent } from '../utils/publicAgent';
import { NsfwService } from '../modules/nsfw/nsfw.service';

jest.mock('axios');
const get = axios.get as jest.Mock;
const isAxiosError = axios.isAxiosError as unknown as jest.Mock;
const service = new NsfwService();
beforeEach(() => {
  get.mockReset();
  isAxiosError.mockImplementation((error) => error?.isAxiosError === true);
});

it.each([
  [
    'getDanbooru',
    ['cat ears', 5],
    'https://danbooru.donmai.us/posts.json?limit=5&tags=cat%20ears+rating:explicit',
  ],
  ['getWaifuIm', ['waifu', false], 'https://api.waifu.im/images?IncludedTags=waifu&IsNsfw=false'],
  ['getNhentaiGallery', ['123'], 'https://nhentai.net/api/v2/galleries/123'],
  ['searchNhentai', ['hello world'], 'https://nhentai.net/api/v2/search?query=hello%20world'],
  ['getPurrbot', ['neko'], 'https://purrbot.site/api/img/nsfw/neko/gif'],
] as const)('requests %s with encoded parameters and a timeout', async (method, args, url) => {
  get.mockResolvedValue({ data: '{"fixture":true}' });
  const invoke = service[method].bind(service) as (
    ...params: readonly unknown[]
  ) => Promise<unknown>;
  await expect(invoke(...args)).resolves.toEqual({ fixture: true });
  expect(get).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      timeout: 15000,
      maxRedirects: 0,
      proxy: false,
      adapter: 'http',
      httpAgent: publicHttpAgent,
      httpsAgent: publicHttpsAgent,
      maxContentLength: 5 * 1024 * 1024,
    }),
  );
});

it('reports connection failures as gateway errors', async () => {
  get.mockRejectedValue(new Error('connection refused'));
  await expect(service.getWaifuIm('waifu', false)).rejects.toMatchObject({ statusCode: 502 });
});

it('does not expose raw upstream request details', async () => {
  get.mockRejectedValue(new Error('Authorization=private-token /private/config'));
  await expect(service.getWaifuIm('waifu', false)).rejects.toMatchObject({
    statusCode: 502,
    message: expect.not.stringMatching(/private-token|private\/config/),
  });
});

it.each([403, 503])(
  'reports upstream HTTP %s without another extraction attempt',
  async (statusCode) => {
    get.mockRejectedValue({ isAxiosError: true, response: { status: statusCode } });
    await expect(service.getDanbooru('cat', 1)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining(`HTTP ${statusCode}`),
    });
    expect(get).toHaveBeenCalledTimes(1);
  },
);

it('reports invalid upstream JSON as a gateway error', async () => {
  get.mockResolvedValue({ data: '{broken-json' });
  await expect(service.getNhentaiGallery('123')).rejects.toMatchObject({
    statusCode: 502,
    message: expect.stringContaining('JSON tidak valid'),
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([
  '<html>blocked</html>',
  '<!DOCTYPE html><title>Verification</title>',
  'Just a moment',
  'Missing authentication',
  'Cloudflare',
  'Enable JavaScript',
])('rejects challenge responses: %s', async (body) => {
  get.mockResolvedValue({ data: body });
  await expect(service.getPurrbot('neko')).rejects.toMatchObject({
    statusCode: 502,
    message: expect.stringContaining('halaman verifikasi'),
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it('preserves the obsolete API error', async () => {
  get.mockResolvedValue({ data: 'Use new API' });
  await expect(service.searchNhentai('test')).rejects.toMatchObject({
    statusCode: 502,
    message: 'NHentai Search API telah usang atau berubah.',
  });
});

it('preserves valid JSON objects containing verification-related words', async () => {
  const data = { source: 'Cloudflare', results: [] };
  get.mockResolvedValue({ data: JSON.stringify(data) });
  await expect(service.getWaifuIm('waifu', false)).resolves.toEqual(data);
});

it('rejects redirects without following another request', async () => {
  get.mockRejectedValue({ isAxiosError: true, response: { status: 302 } });
  await expect(service.getWaifuIm('waifu', false)).rejects.toMatchObject({ statusCode: 502 });
  expect(get).toHaveBeenCalledTimes(1);
});
