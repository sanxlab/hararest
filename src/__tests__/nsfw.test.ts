import axios from 'axios';
import { publicHttpAgent, publicHttpsAgent } from '../utils/publicAgent';
import { NsfwService } from '../modules/nsfw/nsfw.service';

jest.mock('axios');
const get = axios.get as jest.Mock;
const isAxiosError = axios.isAxiosError as unknown as jest.Mock;
const service = new NsfwService();
const originalRule34Url = process.env.RULE34_API_URL;
const originalRule34UserId = process.env.RULE34_USER_ID;
const originalRule34ApiKey = process.env.RULE34_API_KEY;

beforeEach(() => {
  get.mockReset();
  isAxiosError.mockImplementation((error) => error?.isAxiosError === true);
  process.env.RULE34_API_URL = 'https://api.rule34.xxx';
  process.env.RULE34_USER_ID = '12345';
  process.env.RULE34_API_KEY = 'secret-rule34-key';
});

afterEach(() => {
  if (originalRule34Url === undefined) delete process.env.RULE34_API_URL;
  else process.env.RULE34_API_URL = originalRule34Url;
  if (originalRule34UserId === undefined) delete process.env.RULE34_USER_ID;
  else process.env.RULE34_USER_ID = originalRule34UserId;
  if (originalRule34ApiKey === undefined) delete process.env.RULE34_API_KEY;
  else process.env.RULE34_API_KEY = originalRule34ApiKey;
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

describe('Rule34', () => {
  it('requests Rule34 with encoded tags, pagination, and configured credentials', async () => {
    const posts = [{ id: 101, file_url: 'https://img.rule34.xxx/sample.jpg', score: 12 }];
    get.mockResolvedValue({ data: JSON.stringify(posts) });
    await expect(service.getRule34('cat_ears 1girl', 5, 2)).resolves.toEqual(posts);
    expect(get).toHaveBeenCalledWith(
      'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=5&tags=cat_ears+1girl&pid=2&user_id=12345&api_key=secret-rule34-key',
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

  it('defaults RULE34_API_URL to https://api.rule34.xxx and omits pid when undefined', async () => {
    delete process.env.RULE34_API_URL;
    get.mockResolvedValue({ data: '[]' });
    await expect(service.getRule34('solo', 10)).resolves.toEqual([]);
    expect(get).toHaveBeenCalledWith(
      'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1&limit=10&tags=solo&user_id=12345&api_key=secret-rule34-key',
      expect.any(Object),
    );
  });

  it('returns an empty array when Rule34 responds with an empty body', async () => {
    get.mockResolvedValue({ data: '   ' });
    await expect(service.getRule34('nonexistent_tag', 10)).resolves.toEqual([]);
  });

  it('validates input parameters before checking Rule34 configuration', async () => {
    delete process.env.RULE34_USER_ID;
    delete process.env.RULE34_API_KEY;
    await expect(service.getRule34(' ', 10)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.getRule34('solo', 0)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.getRule34('solo', 10, -1)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({ statusCode: 500 });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects invalid RULE34_API_URL values', async () => {
    process.env.RULE34_API_URL = 'https://user:pass@api.rule34.xxx';
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({ statusCode: 500 });
    process.env.RULE34_API_URL = 'not-a-url';
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({ statusCode: 500 });
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects non-array Rule34 JSON responses and authentication failures', async () => {
    get.mockResolvedValueOnce({ data: '{"success":"false","message":"Invalid API key"}' });
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({ statusCode: 502 });

    get.mockResolvedValueOnce({ data: 'Missing authentication. Go to api.rule34.xxx for more information' });
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('menolak akses'),
    });
  });

  it('does not leak Rule34 credentials when an upstream request fails', async () => {
    get.mockRejectedValue(new Error('Request failed with api_key=secret-rule34-key&user_id=12345'));
    await expect(service.getRule34('solo', 10)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.not.stringMatching(/secret-rule34-key|12345/),
    });
  });
});
