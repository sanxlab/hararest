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
                    { ext: 'mp4', height: 1080 },
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
            expect(response.body.data.videos).toEqual(['480p', '720p', '1080p']);
            expect(mockExecFile.mock.calls[0][1]).toContain('--no-playlist');
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
                    const output = _args[_args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
                    fs.writeFileSync(output, 'video');
                    callback(null, output + '\n', '');
                }
            );

            const service = new YoutubeService();
            const output = await service.downloadVideo('https://youtube.com/watch?v=video123');
            expect(fs.readFileSync(output, 'utf8')).toBe('video');
            fs.unlinkSync(output);

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
                        const output = _args[_args.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
                        fs.writeFileSync(output, 'retried-video');
                        callback(null, output + '\n', '');
                    }
                );

            const service = new YoutubeService();
            (service as unknown as { cookiePath: string }).cookiePath = cookiePath;

            const output = await service.downloadVideo('https://youtube.com/watch?v=video123');
            expect(fs.readFileSync(output, 'utf8')).toBe('retried-video');
            fs.unlinkSync(output);
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

describe('YouTube download lifecycle', () => {
    let directory: string;
    let service: YoutubeService;
    beforeEach(() => {
        mockExecFile.mockReset();
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-regression-'));
        service = new YoutubeService();
        Object.assign(service, { tmpDir: directory, cookiePath: path.join(directory, 'absent-cookies') });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('isolates simultaneous downloads even with the same timestamp', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(123456789);
        mockExecFile.mockImplementation((_file: string, args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
            const extension = args.includes('--extract-audio') ? 'mp3' : 'mp4';
            const output = args[args.indexOf('-o') + 1].replace('%(ext)s', extension);
            fs.writeFileSync(output, 'finished');
            setImmediate(() => callback(null, output + '\n', ''));
        });
        const outputs = await Promise.all([service.downloadVideo('https://youtu.be/123'), service.downloadVideo('https://youtu.be/123'), service.downloadAudio('https://youtu.be/123')]);
        expect(new Set(outputs).size).toBe(3);
        expect(outputs.every((file) => fs.existsSync(file))).toBe(true);
        for (const call of mockExecFile.mock.calls) {
            expect(call[1]).toEqual(expect.arrayContaining(['--no-playlist', '--print', 'after_move:filepath']));
            expect(call[2]).toMatchObject({ timeout: 540000 });
        }
    });

    it('removes partial output after a failed download', async () => {
        fs.writeFileSync(path.join(directory, 'unrelated.mp4'), 'keep');
        mockExecFile.mockImplementation((_file: string, args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
            const output = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp4.part');
            fs.writeFileSync(output, 'partial');
            callback(new Error('network failure'), '', '');
        });
        await expect(service.downloadVideo('https://youtu.be/123')).rejects.toMatchObject({ statusCode: 500 });
        expect(fs.readdirSync(directory)).toEqual(['unrelated.mp4']);
    });

    it('does not return a progress-log path to an unfinished intermediate file', async () => {
        mockExecFile.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
            callback(null, 'Destination: /tmp/intermediate.webm\n', '');
        });
        await expect(service.downloadAudio('https://youtu.be/123')).rejects.toMatchObject({ statusCode: 500 });
    });
});
