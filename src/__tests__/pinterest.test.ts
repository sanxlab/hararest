import axios from 'axios';
import { PinterestService } from '../modules/pinterest/pinterest.service';

jest.mock('axios', () => {
  const get = jest.fn();
  return {
    __esModule: true,
    default: { get, create: jest.fn(() => ({ get })) },
  };
});
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Also mock pinterestClient instance created in pinterest.service
jest.mock('../../src/utils/publicAgent', () => ({
  publicHttpAgent: {},
  httpsAgent: {},
  publicHttpsAgent: {},
}));

describe('PinterestService', () => {
  let service: PinterestService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PinterestService();
  });

  it('extracts valid username from username string or URLs', () => {
    expect(service.extractUsername('johndoe')).toBe('johndoe');
    expect(service.extractUsername('@johndoe')).toBe('johndoe');
    expect(service.extractUsername('https://www.pinterest.com/johndoe/')).toBe('johndoe');
    expect(service.extractUsername('https://id.pinterest.com/johndoe')).toBe('johndoe');
    expect(() => service.extractUsername('')).toThrow();
    expect(() => service.extractUsername('   ')).toThrow();
  });

  it('searches pins successfully', async () => {
    // axios.create returns an instance which calls get
    mockedAxios.get.mockResolvedValueOnce({
      data: {
        resource_response: {
          data: {
            results: [
              {
                id: '123456',
                description: 'A cute cat',
                images: { orig: { url: 'https://i.pinimg.com/originals/cat.jpg' } },
                pinner: { username: 'catlover', full_name: 'Cat Lover' },
              },
            ],
          },
        },
      },
    });

    const res = await service.search('cat');
    expect(res.results.length).toBe(1);
    expect(res.results[0].id).toBe('123456');
    expect(res.results[0].images[0]).toBe('https://i.pinimg.com/originals/cat.jpg');
  });

  it('fetches pinterest user profile and pins', async () => {
    mockedAxios.get
      // 1. UserResource
      .mockResolvedValueOnce({
        data: {
          resource_response: {
            data: {
              username: 'designpro',
              full_name: 'Design Pro',
              about: 'Graphic designer portfolio',
              image_xlarge_url: 'https://i.pinimg.com/avatar.jpg',
              follower_count: 500,
              following_count: 100,
              pin_count: 50,
            },
          },
        },
      })
      // 2. UserPinsResource
      .mockResolvedValueOnce({
        data: {
          resource_response: {
            data: [
              {
                id: '998877',
                grid_title: 'Poster Art',
                images: { orig: { url: 'https://i.pinimg.com/originals/poster.jpg' } },
                native_creator: { full_name: 'Design Pro', username: 'designpro' },
              },
            ],
          },
        },
      });

    const res = await service.user('designpro');
    expect(res.user.username).toBe('designpro');
    expect(res.user.fullName).toBe('Design Pro');
    expect(res.user.followers).toBe(500);
    expect(res.pins.length).toBe(1);
    expect(res.pins[0].id).toBe('998877');
  });
});
