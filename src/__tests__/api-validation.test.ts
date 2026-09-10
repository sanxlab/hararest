import supertest from 'supertest';
import app from '../app';
import { BraveService } from '../modules/brave/brave.service';
import { PinterestService } from '../modules/pinterest/pinterest.service';
import { PixivService } from '../modules/pixiv/pixiv.service';
import { NsfwService } from '../modules/nsfw/nsfw.service';
import { OcrService } from '../modules/ocr/ocr.service';
import { ThreadsService } from '../modules/threads/threads.service';

jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../modules/brave/brave.service');
jest.mock('../modules/pinterest/pinterest.service');
jest.mock('../modules/pixiv/pixiv.service');
jest.mock('../modules/nsfw/nsfw.service');
jest.mock('../modules/ocr/ocr.service');
jest.mock('../modules/threads/threads.service');

describe('API validation and routes', () => {
  it.each([
    '/api/youtube/search?q=test&limit=abc',
    '/api/youtube/search?q=test&limit=1.5',
    '/api/youtube/search?q=test&limit=11',
    '/api/youtube/video?url=https://youtu.be/test&quality=abc',
    '/api/youtube/video?url=https://youtu.be/test&quality=720p&quality=480p',
    '/api/brave/search?q=test&num=21',
    '/api/brave/search?q=test&num=2cats',
    '/api/nsfw/danbooru?tags=test&limit=0',
    '/api/nsfw/danbooru?tags=test&limit=NaN',
    '/api/nsfw/waifu?tag=waifu&nsfw=maybe',
    '/api/nsfw/nhentai/gallery/abc123',
    '/api/nsfw/purrbot/bad%2Fcategory',
    '/api/tiktok/trending?region=USA',
    '/api/tiktok/user?username=test&cursor=1&cursor=2',
    '/api/tiktok/search?query=%20',
    '/api/pinterest/search?q=%20',
    '/api/pixiv/search?q=%20',
    '/api/instagram?url=https://instagram.com/p/1&url=https://instagram.com/p/2',
    '/api/facebook?url=',
    '/api/twitter/download?url=%20',
    '/api/threads/download?url=https://user:pass@threads.com/post/1',
    '/api/xiaohongshu?url=https://xiaohongshu.com:8080/post/1',
  ])('rejects malformed parameters: %s', async (url) => {
    expect((await supertest(app).get(url)).status).toBe(400);
  });

  it.each([
    ['/api/brave/search?q=test&num=3', BraveService.prototype.search, ['test', 3]],
    ['/api/pinterest?url=https://pin.it/test', PinterestService.prototype.download, ['https://pin.it/test']],
    ['/api/pinterest/search?q=test', PinterestService.prototype.search, ['test']],
    ['/api/pixiv?id=123', PixivService.prototype.download, ['123']],
    ['/api/pixiv/search?q=test', PixivService.prototype.search, ['test']],
    ['/api/nsfw/danbooru?tags=test&limit=5', NsfwService.prototype.getDanbooru, ['test', 5]],
    ['/api/nsfw/waifu?tag=waifu&nsfw=false', NsfwService.prototype.getWaifuIm, ['waifu', false]],
    ['/api/nsfw/nhentai/gallery/123', NsfwService.prototype.getNhentaiGallery, ['123']],
    ['/api/nsfw/nhentai/search?query=test', NsfwService.prototype.searchNhentai, ['test']],
    ['/api/nsfw/purrbot/neko', NsfwService.prototype.getPurrbot, ['neko']],
    ['/api/threads/download?url=https://threads.com/@user/post/123', ThreadsService.prototype.download, ['https://threads.com/@user/post/123']],
  ])('dispatches valid requests: %s', async (url, method, args) => {
    (method as jest.Mock).mockResolvedValue({ result: 'fixture' });
    const response = await supertest(app).get(url as string);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ result: 'fixture' });
    expect(method).toHaveBeenCalledWith(...args as unknown[]);
  });

  it('sends raw image bytes to OCR', async () => {
    (OcrService.prototype.extractText as jest.Mock).mockResolvedValue('hello');
    const data = Buffer.from('image fixture');
    const response = await supertest(app).post('/api/ocr').type('image/png').send(data);
    expect(response.status).toBe(200);
    expect(response.body.data.text).toBe('hello');
    expect(OcrService.prototype.extractText).toHaveBeenCalledWith(data);
  });

  it('rejects missing OCR image', async () => {
    expect((await supertest(app).post('/api/ocr')).status).toBe(400);
  });

  it('reports malformed JSON as a client error', async () => {
    const response = await supertest(app).post('/api/ocr').type('json').send('{');
    expect(response.status).toBe(400);
    expect(response.body.status).toBe('fail');
  });

  it('reports oversized image payloads as 413', async () => {
    const response = await supertest(app).post('/api/ocr').type('image/png').send(Buffer.alloc(15 * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(response.body.status).toBe('fail');
  });
});
