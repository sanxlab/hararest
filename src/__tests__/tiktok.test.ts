import supertest from 'supertest';
import app from '../app';
import axios, { AxiosHeaders } from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TikTok Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/tiktok/download', () => {
        it('should return download info for valid URL', async () => {
            mockedAxios.post.mockResolvedValueOnce({
                data: {
                    code: 0,
                    data: {
                        id: '720938293',
                        region: 'US',
                        title: 'TikTok Video',
                        cover: 'http://cover.jpg',
                        duration: 60,
                        size: 1024,
                        play: 'http://video.mp4',
                        images: null,
                        music: 'http://music.mp3',
                        music_info: { id: 'm1', title: 'Song', cover: 'c.jpg', author: 'Singer', duration: 10 },
                        play_count: 100,
                        comment_count: 10,
                        share_count: 5,
                        download_count: 1,
                        create_time: 1678787878,
                        author: { id: 'a1', unique_id: 'user', nickname: 'Nick', avatar: 'a.jpg' }
                    }
                },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {
                    headers: new AxiosHeaders(),
                    url: ''
                }
            });

            const response = await supertest(app).get('/api/tiktok/download?url=https://tiktok.com/video/123');
            expect(response.status).toBe(200);
            expect(response.body.data.id).toBe('720938293');
        });

        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/tiktok/download');
            expect(response.status).toBe(400);
        });
    });

    describe('GET /api/tiktok/trending', () => {
        it('should return trending feed', async () => {
            mockedAxios.post.mockResolvedValueOnce({
                data: {
                    code: 0,
                    data: [{
                        video_id: 'v1',
                        region: 'US',
                        title: 'Trending',
                        music_info: {},
                        author: {}
                    }]
                },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {
                    headers: new AxiosHeaders(),
                    url: ''
                }
            });

            const response = await supertest(app).get('/api/tiktok/trending');
            expect(response.status).toBe(200);
            expect(Array.isArray(response.body.data)).toBe(true);
        });
    });
});
