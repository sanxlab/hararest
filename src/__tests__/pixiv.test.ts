import axios from 'axios';
import { PixivService } from '../modules/pixiv/pixiv.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const service = new PixivService();

it.each(['download', 'search', 'user'] as const)('does not expose raw upstream failures in %s', async (method) => {
  mockedAxios.get.mockRejectedValueOnce(new Error('Authorization=private-token /private/config'));
  await expect(service[method]('123')).rejects.toMatchObject({
    statusCode: 502,
    message: expect.not.stringMatching(/private-token|private\/config/),
  });
});

it.each([1e12, '2', 1.5, -1, Infinity])('rejects unsafe fallback page counts before probing or allocating pages: %s', async (pageCount) => {
  mockedAxios.get.mockResolvedValueOnce({ data: { body: {
    id: '123',
    pageCount,
    userIllusts: { '123': { url: 'https://i.pximg.net/img/2026/09/21/00/00/00/123_p0_square1200.jpg' } },
  } } });
  mockedAxios.get.mockRejectedValueOnce(new Error('No pages'));

  await expect(service.download('123')).rejects.toMatchObject({ statusCode: 502 });
  expect(mockedAxios.head).not.toHaveBeenCalled();
});

it('retains valid multi-page fallback media', async () => {
  mockedAxios.get.mockResolvedValueOnce({ data: { body: {
    id: '123',
    title: 'Artwork',
    userName: 'Artist',
    pageCount: 2,
    userIllusts: { '123': { url: 'https://i.pximg.net/img/2026/09/21/00/00/00/123_p0_square1200.jpg' } },
  } } });
  mockedAxios.get.mockRejectedValueOnce(new Error('No pages'));
  mockedAxios.head.mockResolvedValueOnce({});

  await expect(service.download('123')).resolves.toMatchObject({
    urls: [
      'https://i.pximg.net/img-original/img/2026/09/21/00/00/00/123_p0.jpg',
      'https://i.pximg.net/img-original/img/2026/09/21/00/00/00/123_p1.jpg',
    ],
  });
});

it('detects NSFW R-18 artwork on download', async () => {
  mockedAxios.get.mockResolvedValueOnce({
    data: {
      body: {
        id: '456',
        title: 'NSFW Artwork',
        userName: 'Artist',
        xRestrict: 1,
        tags: { tags: [{ tag: 'R-18' }, { tag: 'original' }] },
        urls: { original: 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/456_p0.jpg' },
      },
    },
  });
  mockedAxios.get.mockResolvedValueOnce({
    data: {
      body: [{ urls: { original: 'https://i.pximg.net/img-original/img/2026/01/01/00/00/00/456_p0.jpg' } }],
    },
  });

  const result = await service.download('456');
  expect(result.nsfw).toBe(true);
  expect(result.xRestrict).toBe(1);
  expect(result.tags).toContain('R-18');
});

it('fetches pixiv user profile and artworks with NSFW filter', async () => {
  mockedAxios.get.mockResolvedValueOnce({
    data: {
      body: {
        userId: '789',
        name: 'PixivArtist',
        comment: 'Hello pixiv',
        imageBig: 'https://i.pximg.net/user/avatar.jpg',
      },
    },
  });
  mockedAxios.get.mockResolvedValueOnce({
    data: {
      body: {
        illusts: {
          '1001': { id: '1001', title: 'Safe Art', url: 'https://i.pximg.net/art1.jpg', xRestrict: 0, tags: ['safe'] },
          '1002': { id: '1002', title: 'R-18 Art', url: 'https://i.pximg.net/art2.jpg', xRestrict: 1, tags: ['R-18'] },
        },
      },
    },
  });

  // Default mode: all
  const result = await service.user('789');
  expect(result.user.name).toBe('PixivArtist');
  expect(result.artworks.length).toBe(2);

  // Safe mode only
  mockedAxios.get.mockResolvedValueOnce({
    data: { body: { userId: '789', name: 'PixivArtist' } },
  });
  mockedAxios.get.mockResolvedValueOnce({
    data: {
      body: {
        illusts: {
          '1001': { id: '1001', title: 'Safe Art', url: 'https://i.pximg.net/art1.jpg', xRestrict: 0 },
          '1002': { id: '1002', title: 'R-18 Art', url: 'https://i.pximg.net/art2.jpg', xRestrict: 1 },
        },
      },
    },
  });
  const safeResult = await service.user('789', { nsfw: false });
  expect(safeResult.artworks.length).toBe(1);
  expect(safeResult.artworks[0].id).toBe('1001');
  expect(safeResult.artworks[0].nsfw).toBe(false);
});
