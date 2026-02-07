import supertest from 'supertest';
import app from '../app';
import axios, { AxiosHeaders } from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Xiaohongshu Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/xiaohongshu', () => {
        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/xiaohongshu');
            expect(response.status).toBe(400);
        });

        it('should return video data for valid URL', async () => {
            const mockState = {
                noteData: {
                    data: {
                        noteData: {
                            noteId: 'test_id',
                            time: 12345678,
                            type: 'video',
                            title: 'Test Title',
                            desc: 'Test Desc',
                            user: { userId: 'u1', nickName: 'User', avatar: 'a.jpg' },
                            tagList: [],
                            interactInfo: { likedCount: '10', collectedCount: '5', shareCount: '2', niceCount: '1' },
                            imageList: [{ url: 'v.jpg', width: 100, height: 100, fileId: 'v1' }],
                            cover: { fileId: 'c1', url: 'cover.jpg' },
                            video: {
                                media: {
                                    stream: {
                                        h264: [{ width: 720, height: 1280, videoBitrate: 1000, duration: 10, size: 5000, masterUrl: 'video.mp4' }]
                                    }
                                }
                            }
                        },
                        commentData: { commentCount: 3 }
                    }
                }
            };

            const mockHtml = `<html><body><script>window.__INITIAL_STATE__=${JSON.stringify(mockState)}</script></body></html>`;

            mockedAxios.get.mockResolvedValueOnce({
                data: mockHtml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: { headers: new AxiosHeaders(), url: '' }
            });

            const response = await supertest(app).get('/api/xiaohongshu?url=http://xhs.com/123');
            expect(response.status).toBe(200);
            expect(response.body.data.id).toBe('test_id');
            expect(response.body.data.type).toBe('video');
            expect(response.body.data.video.url).toBe('video.mp4');
        });
    });
});
