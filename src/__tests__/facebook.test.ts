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
        it('should return video info from FDown extractor', async () => {
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
