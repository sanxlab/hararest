import { NsfwService } from '../modules/nsfw/nsfw.service';

const get = jest.fn();
const service = new NsfwService();
Object.assign(service, { getGotScraping: async () => ({ get }) });
beforeEach(() => get.mockReset());

it.each([
  ['getDanbooru', ['cat ears', 5], 'https://danbooru.donmai.us/posts.json?limit=5&tags=cat%20ears+rating:explicit'],
  ['getWaifuIm', ['waifu', false], 'https://api.waifu.im/images?IncludedTags=waifu&IsNsfw=false'],
  ['getNhentaiGallery', ['123'], 'https://nhentai.net/api/v2/galleries/123'],
  ['searchNhentai', ['hello world'], 'https://nhentai.net/api/v2/search?query=hello%20world'],
  ['getPurrbot', ['neko'], 'https://purrbot.site/api/img/nsfw/neko/gif'],
] as const)('requests %s with encoded parameters and a timeout', async (method, args, url) => {
  get.mockResolvedValue({ body: { fixture: true } });
  const invoke = service[method].bind(service) as (...params: readonly unknown[]) => Promise<unknown>;
  await expect(invoke(...args)).resolves.toEqual({ fixture: true });
  expect(get).toHaveBeenCalledWith(url, expect.objectContaining({ timeout: { request: 15000 }, retry: { limit: 1 } }));
});

it('reports connection failures as gateway errors', async () => {
  get.mockRejectedValue(new Error('connection refused'));
  await expect(service.getWaifuIm('waifu', false)).rejects.toMatchObject({ statusCode: 502 });
});
