import axios from 'axios';
import { Request, Response } from 'express';
import { PixivController } from '../modules/pixiv/pixiv.controller';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

it.each([
  [{ mode: 'all' }, ['1002', '1001']],
  [{ mode: 'safe' }, ['1001']],
  [{ mode: 'r18' }, ['1002']],
  [{}, ['1002', '1001']],
  [{ nsfw: 'false' }, ['1001']],
  [{ nsfw: 'true' }, ['1002']],
])('honors profile filtering at the controller boundary: %j', async (query, ids) => {
  mockedAxios.get.mockResolvedValueOnce({ data: { body: { userId: '789', name: 'Artist' } } });
  mockedAxios.get.mockResolvedValueOnce({ data: { body: { illusts: {
    '1001': { id: '1001', title: 'Safe', url: 'https://i.pximg.net/safe.jpg', xRestrict: 0 },
    '1002': { id: '1002', title: 'R18', url: 'https://i.pximg.net/r18.jpg', xRestrict: 1 },
  } } } });
  const json = jest.fn();
  const next = jest.fn();
  await new PixivController().user(
    { query: { id: '789', ...query } } as unknown as Request,
    { json } as unknown as Response,
    next,
  );
  expect(next).not.toHaveBeenCalled();
  expect(json).toHaveBeenCalledTimes(1);
  expect(json.mock.calls[0][0].data.artworks.map((artwork: { id: string }) => artwork.id)).toEqual(ids);
});
