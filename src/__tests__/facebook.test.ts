jest.mock('node-fetch');
jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return {
        ...actual,
        execFile: jest.fn()
    };
});

import supertest from 'supertest';
import app from '../app';
import fetch from 'node-fetch';
import { execFile } from 'child_process';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedExecFile = execFile as unknown as jest.Mock;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

describe('Facebook Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/facebook', () => {
        it('should return video info from SnapSave extractor', async () => {
            mockedExecFile.mockImplementation((...args: unknown[]) => {
                const callback = args[args.length - 1];
                if (typeof callback === 'function') {
                    (callback as ExecFileCallback)(
                        null,
                        JSON.stringify({
                            status: 'ok',
                            media_links: [
                                {
                                    quality: 'hd',
                                    label: 'Download HD',
                                    url: 'https://video.example.com/file.mp4'
                                }
                            ]
                        }),
                        ''
                    );
                }

                return {} as never;
            });

            mockedFetch.mockResolvedValueOnce({
                ok: true,
                headers: { get: () => '1024' }
            });

            const response = await supertest(app).get('/api/facebook?url=https://facebook.com/watch?v=123');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.thumbnail).toBe('');
            expect(response.body.data.videos[0]).toEqual({
                quality: 'hd',
                url: 'https://video.example.com/file.mp4',
                size: 1024,
                fSize: '1.0 KB'
            });
        });

        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/facebook');
            expect(response.status).toBe(400);
        });

        it('should return 403 for a disallowed facebook url', async () => {
            const response = await supertest(app).get('/api/facebook?url=https://google.com');
            expect(response.status).toBe(403);
        });
    });
});

it('falls back to yt-dlp when SnapSave is blocked and excludes silent DASH streams', async () => {
    mockedExecFile.mockReset();
    mockedExecFile.mockImplementation((...args: unknown[]) => {
        const commandArgs = args[1] as string[];
        const callback = args[args.length - 1] as ExecFileCallback;
        if (commandArgs.includes('--dump-single-json')) {
            callback(null, JSON.stringify({ thumbnail: 'https://cdn.example.com/thumb.jpg', formats: [
                { format_id: 'sd', ext: 'mp4', url: 'https://cdn.example.com/sd.mp4', filesize: 1024 },
                { format_id: 'hd', ext: 'mp4', url: 'https://cdn.example.com/hd.mp4', filesize: 2048 },
                { format_id: 'dash', ext: 'mp4', url: 'https://cdn.example.com/silent.mp4', acodec: 'none' },
                { format_id: 'audio', ext: 'm4a', url: 'https://cdn.example.com/audio.m4a', vcodec: 'none' },
            ] }), '');
        } else callback(Object.assign(new Error('SnapSave failed'), { stderr: '{"message":"Robot Check"}' }), '', '{"message":"Robot Check"}');
        return {} as never;
    });
    const response = await supertest(app).get('/api/facebook').query({ url: 'https://facebook.com/watch?v=123' });
    expect(response.status).toBe(200);
    expect(response.body.data.videos).toEqual([
        { quality: 'sd', url: 'https://cdn.example.com/sd.mp4', size: 1024, fSize: '1.0 KB' },
        { quality: 'hd', url: 'https://cdn.example.com/hd.mp4', size: 2048, fSize: '2.0 KB' },
    ]);
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
});
