import supertest from 'supertest';
import app from '../app';
import * as child_process from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { YoutubeService } from '../modules/youtube/youtube.service';

// Mock child_process
jest.mock('child_process');
const mockExecFile = child_process.execFile as unknown as jest.Mock;

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

            mockExecFile.mockImplementation(
                (
                    _file: string,
                    _args: string[],
                    _options: object,
                    callback: (error: Error | null, stdout: string, stderr: string) => void
                ) => {
                    callback(null, mockOutput, '');
                }
            );

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

    describe('yt-dlp process arguments', () => {
        it('does not pass an empty cookie file to yt-dlp', async () => {
            const cookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-empty-cookie-'));
            const cookiePath = path.join(cookieDir, 'cookies.txt');
            fs.writeFileSync(cookiePath, '');

            mockExecFile.mockImplementation(
                (
                    _file: string,
                    _args: string[],
                    _options: object,
                    callback: (error: Error | null, stdout: string, stderr: string) => void
                ) => {
                    callback(null, JSON.stringify({ id: 'video123', formats: [] }), '');
                }
            );

            const service = new YoutubeService();
            (service as unknown as { cookiePath: string }).cookiePath = cookiePath;

            await expect(service.getInfo('https://youtube.com/watch?v=video123')).resolves.toMatchObject({ id: 'video123' });
            expect(mockExecFile).toHaveBeenCalledWith(
                expect.any(String),
                expect.not.arrayContaining(['--cookies']),
                expect.any(Object),
                expect.any(Function)
            );

            fs.rmSync(cookieDir, { recursive: true, force: true });
        });

        it('uses the 360p format selector as structured execFile arguments', async () => {
            mockExecFile.mockImplementation(
                (
                    _file: string,
                    _args: string[],
                    _options: object,
                    callback: (error: Error | null, stdout: string, stderr: string) => void
                ) => {
                    callback(null, 'Destination: /tmp/video.mp4\n', '');
                }
            );

            const service = new YoutubeService();
            await expect(service.downloadVideo('https://youtube.com/watch?v=video123')).resolves.toBe('/tmp/video.mp4');

            expect(mockExecFile).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining(['-f', '18/b[height<=360]/bv*[height<=360]+ba/b']),
                expect.any(Object),
                expect.any(Function)
            );
        });

        it('retries a cookie-backed HTTP 403 once without cookies', async () => {
            const cookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-cookie-'));
            const cookiePath = path.join(cookieDir, 'cookies.txt');
            fs.writeFileSync(cookiePath, '# Netscape HTTP Cookie File\n');

            mockExecFile
                .mockImplementationOnce(
                    (
                        _file: string,
                        _args: string[],
                        _options: object,
                        callback: (error: Error | null, stdout: string, stderr: string) => void
                    ) => {
                        callback(new Error('HTTP Error 403: Forbidden'), '', 'ERROR: HTTP Error 403: Forbidden');
                    }
                )
                .mockImplementationOnce(
                    (
                        _file: string,
                        _args: string[],
                        _options: object,
                        callback: (error: Error | null, stdout: string, stderr: string) => void
                    ) => {
                        callback(null, 'Destination: /tmp/retried-video.mp4\n', '');
                    }
                );

            const service = new YoutubeService();
            (service as unknown as { cookiePath: string }).cookiePath = cookiePath;

            await expect(service.downloadVideo('https://youtube.com/watch?v=video123')).resolves.toBe('/tmp/retried-video.mp4');
            expect(mockExecFile).toHaveBeenNthCalledWith(
                1,
                expect.any(String),
                expect.arrayContaining(['--cookies', cookiePath]),
                expect.any(Object),
                expect.any(Function)
            );
            expect(mockExecFile).toHaveBeenNthCalledWith(
                2,
                expect.any(String),
                expect.not.arrayContaining(['--cookies']),
                expect.any(Object),
                expect.any(Function)
            );

            fs.rmSync(cookieDir, { recursive: true, force: true });
        });
    });
});
