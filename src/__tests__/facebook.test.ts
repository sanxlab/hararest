jest.mock('node-fetch');
jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return {
        ...actual,
        execFile: jest.fn()
    };
});

// The page extractor must never reach the real network from tests.
jest.mock('../utils/http', () => ({ getPublicPage: jest.fn() }));

import supertest from 'supertest';
import { getPublicPage } from '../utils/http';
import { extractFacebookPageVideos } from '../modules/facebook/facebook.service';
import app from '../app';
import fetch from 'node-fetch';
import { execFile } from 'child_process';

const mockedFetch = fetch as unknown as jest.Mock;
const mockedExecFile = execFile as unknown as jest.Mock;
const mockedGetPublicPage = getPublicPage as unknown as jest.Mock;
const noVideoPage = { data: '<html></html>', config: { url: 'https://facebook.com/watch?v=123' } };

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

describe('Facebook Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedGetPublicPage.mockResolvedValue(noVideoPage);
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

it('falls back to yt-dlp when FDown is blocked and excludes silent DASH streams', async () => {
    mockedExecFile.mockReset();
    mockedGetPublicPage.mockReset();
    mockedGetPublicPage.mockResolvedValue(noVideoPage);
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
        } else callback(Object.assign(new Error('FDown failed'), { stderr: '{"message":"Robot Check"}' }), '', '{"message":"Robot Check"}');
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

const pageHtml = [
    '<meta property="og:image" content="https://scontent.xx.fbcdn.net/t.jpg?a=1&amp;b=2" />',
    '"browser_native_sd_url":"https:\\/\\/video-a.xx.fbcdn.net\\/v\\/sd.mp4?efg=x\\u00253D&tag=sd",',
    '"browser_native_hd_url":"https:\\/\\/video-b.xx.fbcdn.net\\/v\\/hd.mp4?tag=hd",',
    '"browser_native_hd_url":"https:\\/\\/video-b.xx.fbcdn.net\\/v\\/hd.mp4?tag=hd"',
].join('');

describe('Facebook page extractor', () => {
    it('reads HD then SD links and decodes JSON escapes', () => {
        expect(extractFacebookPageVideos(pageHtml)).toEqual([
            { quality: 'hd', url: 'https://video-b.xx.fbcdn.net/v/hd.mp4?tag=hd' },
            { quality: 'sd', url: 'https://video-a.xx.fbcdn.net/v/sd.mp4?efg=x%3D&tag=sd' },
        ]);
    });

    it('rejects links outside the Facebook CDN or without https', () => {
        expect(extractFacebookPageVideos('"browser_native_hd_url":"https:\\/\\/evil.example.com\\/a.mp4"')).toEqual([]);
        expect(extractFacebookPageVideos('"browser_native_hd_url":"http:\\/\\/video.xx.fbcdn.net\\/a.mp4"')).toEqual([]);
        expect(extractFacebookPageVideos('"browser_native_hd_url":"https:\\/\\/fbcdn.net.evil.com\\/a.mp4"')).toEqual([]);
        expect(extractFacebookPageVideos('"browser_native_hd_url":null')).toEqual([]);
    });

    it('serves a /share/ post from the page when FDown fails, without calling yt-dlp', async () => {
        mockedExecFile.mockReset();
        mockedGetPublicPage.mockReset();
        mockedFetch.mockReset();
        mockedExecFile.mockImplementation((...args: unknown[]) => {
            (args[args.length - 1] as ExecFileCallback)(new Error('FDown failed'), '', '{"message":"FDown returned an unexpected redirect."}');
            return {} as never;
        });
        mockedGetPublicPage.mockResolvedValue({ data: pageHtml, config: { url: 'https://www.facebook.com/1/posts/2/' } });
        mockedFetch.mockResolvedValue({ ok: true, headers: { get: () => '2048' } });

        const response = await supertest(app).get('/api/facebook').query({ url: 'https://www.facebook.com/share/abc/' });

        expect(response.status).toBe(200);
        expect(response.body.data.thumbnail).toBe('https://scontent.xx.fbcdn.net/t.jpg?a=1&b=2');
        expect(response.body.data.videos.map((video: { quality: string }) => video.quality)).toEqual(['hd', 'sd']);
        expect(mockedExecFile).toHaveBeenCalledTimes(1);
        // The resolved post URL, not the share link, is what gets scraped.
        expect(mockedGetPublicPage.mock.calls.at(-1)?.[0]).toBe('https://www.facebook.com/1/posts/2/');
    });
});
