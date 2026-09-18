import { NsfwService } from '../modules/nsfw/nsfw.service';

const get = jest.fn();
const service = new NsfwService();
Object.assign(service, { getGotScraping: async () => ({ get }) });
beforeEach(() => get.mockReset());

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
  get.mockResolvedValue({ body: { fixture: true } });
  const invoke = service[method].bind(service) as (
    ...params: readonly unknown[]
  ) => Promise<unknown>;
  await expect(invoke(...args)).resolves.toEqual({ fixture: true });
  expect(get).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ timeout: { request: 15000 }, retry: { limit: 1 } }),
  );
});

it('reports connection failures as gateway errors', async () => {
  get.mockRejectedValue(new Error('connection refused'));
  await expect(service.getWaifuIm('waifu', false)).rejects.toMatchObject({ statusCode: 502 });
});

it.each([403, 503])(
  'reports upstream HTTP %s without another extraction attempt',
  async (statusCode) => {
    get.mockRejectedValue({ response: { statusCode } });
    await expect(service.getDanbooru('cat', 1)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining(`HTTP ${statusCode}`),
    });
    expect(get).toHaveBeenCalledTimes(1);
  },
);

it('reports invalid upstream JSON as a gateway error', async () => {
  get.mockRejectedValue({ name: 'ParseError', message: 'Unexpected token <' });
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
  get.mockResolvedValue({ body });
  await expect(service.getPurrbot('neko')).rejects.toMatchObject({
    statusCode: 502,
    message: expect.stringContaining('halaman verifikasi'),
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it('preserves the obsolete API error', async () => {
  get.mockResolvedValue({ body: 'Use new API' });
  await expect(service.searchNhentai('test')).rejects.toMatchObject({
    statusCode: 502,
    message: 'NHentai Search API telah usang atau berubah.',
  });
});
