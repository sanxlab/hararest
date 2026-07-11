jest.mock('cloudscraper', () => ({
    jar: jest.fn(),
    get: jest.fn(),
    post: jest.fn()
}));

import supertest from 'supertest';
import app from '../app';
import cloudscraper from 'cloudscraper';

const mockedCloudscraper = cloudscraper as unknown as {
    jar: jest.Mock;
    get: jest.Mock;
    post: jest.Mock;
};

describe('Twitter Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedCloudscraper.jar.mockReturnValue({});
    });

    describe('GET /api/twitter/download', () => {
        it('should return media links for valid X URL', async () => {
            mockedCloudscraper.get.mockResolvedValueOnce(`
                <html>
                    <script>
                        var k_url_search = 'https://savetwitter.net/api/ajaxSearch';
                        var k_lang = 'en';
                    </script>
                    <body>
                        <input name="cf-turnstile-response" value="turnstile-token" />
                    </body>
                </html>
            `);

            mockedCloudscraper.post.mockResolvedValueOnce(JSON.stringify({
                status: 'ok',
                data: `
                    <div>
                        <a href="https://video.twimg.com/ext_tw_video/123.mp4">Download MP4 (720p)</a>
                    </div>
                `
            }));

            const response = await supertest(app).get('/api/twitter/download?url=https://x.com/user/status/123');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.input_url).toBe('https://x.com/user/status/123');
            expect(response.body.data.search_url).toBe('https://savetwitter.net/api/ajaxSearch');
            expect(response.body.data.media_links[0]).toEqual({
                label: 'Download MP4 (720p)',
                quality: '720p',
                media_type: 'video',
                url: 'https://video.twimg.com/ext_tw_video/123.mp4'
            });
        });

        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/twitter/download');
            expect(response.status).toBe(400);
        });

        it('should return 400 for non-twitter URL', async () => {
            const response = await supertest(app).get('/api/twitter/download?url=https://google.com/test');
            expect(response.status).toBe(400);
        });
    });
});
