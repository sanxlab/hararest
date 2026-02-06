import supertest from 'supertest';
import app from '../app';
import * as child_process from 'child_process';
import util from 'util';

// Mock child_process
jest.mock('child_process');
const mockExec = child_process.exec as unknown as jest.Mock;

describe('Youtube Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/youtube/info', () => {
        it('should return video info for a valid URL', async () => {
            const mockOutput = JSON.stringify({
                id: 'video123',
                title: 'Test Video',
                description: 'Description',
                duration: 60,
                view_count: 100,
                like_count: 10,
                comment_count: 5,
                upload_date: '20230101',
                channel_id: 'channel123',
                uploader_id: 'handle',
                uploader: 'Channel Name',
                channel_follower_count: 1000,
                channel_is_verified: true,
                formats: [
                    { ext: 'mp4', height: 720 },
                    { ext: 'mp4', height: 480 },
                ],
            });

            // Mock exec to call the callback with stdout
            mockExec.mockImplementation((cmd: string, options: any, callback: any) => {
                // Handle different signatures of exec if necessary, but util.promisify wraps the one with callback
                if (typeof options === 'function') {
                    callback = options;
                }
                callback(null, { stdout: mockOutput, stderr: '' });
                return { stdout: null, stderr: null } as any;
            });

            const response = await supertest(app).get('/api/youtube/info?url=http://youtube.com/watch?v=video123');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.id).toBe('video123');
            expect(response.body.data.title).toBe('Test Video');
        });

        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/youtube/info');
            expect(response.status).toBe(400);
        });
    });
});
