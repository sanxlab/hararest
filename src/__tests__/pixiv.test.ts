import axios from 'axios';
import { PixivService } from '../modules/pixiv/pixiv.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;
const service = new PixivService();

it.each(['download', 'search'] as const)('does not expose raw upstream failures in %s', async (method) => {
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
