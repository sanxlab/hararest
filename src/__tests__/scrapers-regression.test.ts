import axios from 'axios';
import { XiaohongshuService } from '../modules/xiaohongshu/xiaohongshu.service';
import { PinterestService } from '../modules/pinterest/pinterest.service';
import { PixivService } from '../modules/pixiv/pixiv.service';
import { TiktokService } from '../modules/tiktok/tiktok.service';
import { getPublicPage } from '../utils/http';
import { assertPublicUrl } from '../middlewares/ssrf.middleware';
import * as dns from 'dns/promises';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);
const lookup = dns.lookup as jest.Mock;

beforeEach(() => {
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('Public URLs and redirects', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '240.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1'])('blocks restricted address %s', async (address) => {
    lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(assertPublicUrl('https://pin.it/test', ['pin.it'])).rejects.toMatchObject({ statusCode: 403 });
  });

  it('blocks a redirect to an unrelated host before fetching it', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 302, headers: { location: 'https://example.com/private' } });
    await expect(getPublicPage('https://pin.it/test', ['pin.it', 'pinterest.com'])).rejects.toMatchObject({ statusCode: 403 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it('stops redirect loops', async () => {
    mockedAxios.get.mockResolvedValue({ status: 302, headers: { location: '/again' } });
    await expect(getPublicPage('https://pin.it/test', ['pin.it'])).rejects.toMatchObject({ statusCode: 502 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(6);
  });
});

describe('Pinterest', () => {
  it('resolves short links and recognizes signed MP4 URLs', async () => {
    const payload = { data: { v3GetPinQuery: { data: { title: 'Pin', videos: { videoUrls: { HD: { url: 'https://cdn.example.com/video.mp4?token=123' } } } } } } };
    mockedAxios.get
      .mockResolvedValueOnce({ status: 302, headers: { location: 'https://www.pinterest.com/pin/123/' } })
      .mockResolvedValueOnce({ status: 200, data: `<script>window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST(${JSON.stringify(payload)});</script>` });
    const result = await new PinterestService().download('https://pin.it/abc');
    expect(result.type).toBe('video');
    expect(result.url).toBe('https://cdn.example.com/video.mp4?token=123');
    expect(mockedAxios.get).toHaveBeenLastCalledWith('https://www.pinterest.com/pin/123/', expect.objectContaining({ maxRedirects: 0 }));
  });
});

describe('Xiaohongshu', () => {
  it('reads desktop note state and image URL variants without choosing an unrelated note', async () => {
    const state = { note: { noteDetailMap: {
      abc: { note: { noteId: 'abc', title: 'Wrong post', imageList: [{ urlDefault: 'wrong.jpg' }] } },
      def: { note: { noteId: 'def', title: 'Desktop post', interactInfo: { commentCount: '4' }, imageList: [{ urlDefault: 'original.jpg' }, { urlPre: 'preview.jpg' }] } }
    } } };
    mockedAxios.get.mockResolvedValue({ status: 200, data: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` });
    const result = await new XiaohongshuService().download('https://www.xiaohongshu.com/explore/def');
    expect(result).toMatchObject({ id: 'def', title: 'Desktop post', comments: 4, cover: 'original.jpg' });
    expect(result.images.map((item) => item.url)).toEqual(['original.jpg', 'preview.jpg']);
  });

  it('reads a single desktop video after a short-link redirect', async () => {
    const state = { note: { noteDetailMap: { abc: { note: { noteId: 'abc', type: 'video', video: { media: { stream: { h264: [{ masterUrl: 'video.mp4' }] } } } } } } } };
    mockedAxios.get.mockResolvedValue({ status: 200, data: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` });
    await expect(new XiaohongshuService().download('https://xhslink.com/abc')).resolves.toMatchObject({ id: 'abc', video: { url: 'video.mp4' } });
  });

  it.each([
    { noteData: { data: {} } },
    { note: { noteDetailMap: {} } },
    { noteData: { data: { noteData: { noteId: 'abc', type: 'video' } } } },
    { noteData: { data: { noteData: { noteId: 'abc', imageList: [] } } } }
  ])('reports unavailable post/media as an upstream failure', async (state) => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: `<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>` });
    await expect(new XiaohongshuService().download('https://www.xiaohongshu.com/explore/abc')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('preserves text and all images while parsing multiline state followed by other code', async () => {
    const note = { noteId: '123', title: 'undefined NaN Infinity -Infinity', desc: 'braces } and escaped "quotes"', cover: { fileId: 'cover', url: 'cover.jpg' }, imageList: [{ fileId: 'cover', url: 'cover.jpg' }, { url: 'second.jpg' }] };
    const state = JSON.stringify({ noteData: { data: { noteData: note } }, missing: '__MISSING__' }, null, 2).replace('"__MISSING__"', 'undefined');
    mockedAxios.get.mockResolvedValue({ status: 200, data: `<script>window.__INITIAL_STATE__ = ${state}; window.other = {};</script>` });
    const result = await new XiaohongshuService().download('https://xiaohongshu.com/123');
    expect(result.title).toBe(note.title);
    expect(result.description).toBe(note.desc);
    expect(result.images.map((item) => item.url)).toEqual(['cover.jpg', 'second.jpg']);
    expect(result.cover).toBe('cover.jpg');
  });
});

describe('Pixiv', () => {
  it.each(['garbage123', 'https://evil.example/12345678', 'https://pixiv.net/users/12345678', '0'])('rejects invalid artwork identifier: %s', async (id) => {
    await expect(new PixivService().download(id)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('extracts short legacy IDs without combining unrelated query digits', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { body: { id: '123', title: 'art', userName: 'author' } } })
      .mockResolvedValueOnce({ data: { body: [{ urls: { original: 'https://i.pximg.net/art.png' } }] } });
    const result = await new PixivService().download('https://www.pixiv.net/member_illust.php?illust_id=123&other=456');
    expect(result.id).toBe('123');
    expect(mockedAxios.get).toHaveBeenNthCalledWith(1, 'https://www.pixiv.net/ajax/illust/123', expect.any(Object));
  });

  it('does not invent an original image when all extension probes fail', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { body: { id: '123', userIllusts: { '123': { url: 'https://i.pximg.net/img/2026/01/01/123_p0_square.jpg' } } } } })
      .mockResolvedValueOnce({ data: { error: true } });
    mockedAxios.head.mockRejectedValue(new Error('404'));
    await expect(new PixivService().download('123')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('TikTok', () => {
  it.each(['download', 'trendingFeed', 'userFeed', 'search'] as const)('maps upstream denial in %s to a gateway error', async (method) => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Request failed with status code 403'));
    await expect(new TiktokService()[method]('test')).rejects.toMatchObject({
      statusCode: 502, message: expect.stringContaining('403')
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('keeps video media when images is empty and music metadata is missing', async () => {
    mockedAxios.post.mockResolvedValue({ data: { code: 0, data: { id: '123', images: [], play: 'video.mp4' } } });
    const result = await new TiktokService().download('https://tiktok.com/video/123');
    expect(result.video).toBe('video.mp4');
    expect(result.images).toBeNull();
    expect(result.musicInfo.name).toBe('');
  });

  it.each(['userFeed', 'search'] as const)('encodes cursor values in %s', async (method) => {
    mockedAxios.post.mockResolvedValue({ data: { code: 0, data: { videos: [], cursor: 'next', hasMore: true } } });
    const result = await new TiktokService()[method]('test', '1&count=999');
    const params = new URLSearchParams(mockedAxios.post.mock.calls[0][1] as string);
    expect(params.get('count')).toBe('15');
    expect(params.get('cursor')).toBe('1&count=999');
    expect(result).toEqual({ lists: [], nextId: 'next', next: true });
  });
});

it('parses the two-argument Pinterest Relay callback returned by production', async () => {
    const response = { data: { v3GetPinQueryv2: { data: {
        title: 'Landscape', images_orig: { url: 'https://i.pinimg.com/originals/test.jpg' },
        originPinner: { username: 'artist' }
    } } } };
    mockedAxios.get.mockResolvedValue({ status: 200, data: `
        <script>window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("%7B%22queryID%22%3A%22test%22%7D",${JSON.stringify(response)});</script>
        <script>window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("other-query",{"data":{"otherQuery":{}}});</script>
    ` });
    await expect(new PinterestService().download('https://pinterest.com/pin/123')).resolves.toMatchObject({
        title: 'Landscape', url: 'https://i.pinimg.com/originals/test.jpg', type: 'image', author: 'artist'
    });
});
