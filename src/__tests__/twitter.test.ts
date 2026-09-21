jest.mock('axios');

import supertest from 'supertest';
import app from '../app';
import axios from 'axios';
import { TwitterService } from '../modules/twitter/twitter.service';

const request = jest.mocked(axios.request);
const mediaResponse = { status: 200, headers: {}, data: JSON.stringify({
    status: 'ok', data: '<a href="https://video.twimg.com/123.mp4">Download MP4 (720p)</a>',
}) };

describe('Twitter Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        request.mockReset();
    });

    describe('GET /api/twitter/download', () => {
        it('should return media links for valid X URL', async () => {
            request.mockResolvedValueOnce({ status: 200, headers: {}, data: `
                <html>
                    <script>
                        var k_url_search = '/api/ajaxSearch';
                        var k_lang = 'en';
                    </script>
                    <body>
                        <input name="cf-turnstile-response" value="turnstile-token" />
                    </body>
                </html>
            ` });

            request.mockResolvedValueOnce({ status: 200, headers: {}, data: JSON.stringify({
                status: 'ok',
                data: `
                    <div>
                        <a href="https://video.twimg.com/ext_tw_video/123.mp4">Download MP4 (720p)</a>
                    </div>
                `
            }) });

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

        it('should return 403 for a disallowed Twitter URL', async () => {
            const response = await supertest(app).get('/api/twitter/download?url=https://google.com/test');
            expect(response.status).toBe(403);
        });
    });

    it('preserves provider cookies across allowed redirects and submits encoded search data', async () => {
        request.mockResolvedValueOnce({ status: 302, headers: {
            location: '/en5', 'set-cookie': ['session=first; Path=/; Secure; HttpOnly'],
        }, data: '' });
        request.mockResolvedValueOnce({ status: 200, headers: {
            'set-cookie': ['session=second; Path=/; Secure'],
        }, data: '<input name="cf-turnstile-response" value="token&amp;value" />' });
        request.mockResolvedValueOnce(mediaResponse);

        await new TwitterService().download('https://x.com/user/status/123');

        expect(request.mock.calls[1][0]).toMatchObject({
            url: 'https://savetwitter.net/en5', headers: { Cookie: 'session=first' },
        });
        const post = request.mock.calls[2][0];
        expect(post).toMatchObject({ method: 'POST', headers: { Cookie: 'session=second' } });
        expect(new URLSearchParams(String(post.data)).get('cftoken')).toBe('token&value');
    });

    it.each(['http://127.0.0.1/private', 'https://attacker.example/collect', 'https://user:secret@savetwitter.net/en5']) (
        'rejects an unsafe landing redirect before making a second request: %s', async location => {
            request.mockResolvedValueOnce({ status: 302, headers: { location }, data: '' });
            await expect(new TwitterService().download('https://x.com/user/status/123'))
                .rejects.toMatchObject({ statusCode: 502 });
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it('does not forward search data through a redirected POST', async () => {
        request.mockResolvedValueOnce({ status: 200, headers: {}, data: '' });
        request.mockResolvedValueOnce({ status: 307, headers: { location: 'https://attacker.example' }, data: '' });
        await expect(new TwitterService().download('https://x.com/user/status/123'))
            .rejects.toMatchObject({ statusCode: 502 });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it.each(['https://attacker.example/collect', 'https://user:secret@savetwitter.net/api/ajaxSearch'])(
        'rejects an unsafe endpoint from provider HTML: %s', async endpoint => {
            request.mockResolvedValueOnce({ status: 200, headers: {}, data: `var k_url_search = '${endpoint}';` });
            await expect(new TwitterService().download('https://x.com/user/status/123'))
                .rejects.toMatchObject({ statusCode: 502 });
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it('does not reuse cookies between downloads', async () => {
        const service = new TwitterService();
        request.mockResolvedValueOnce({ status: 200, headers: { 'set-cookie': ['session=private; Path=/'] }, data: '' });
        request.mockResolvedValueOnce(mediaResponse);
        await service.download('https://x.com/user/status/123');
        request.mockResolvedValueOnce({ status: 200, headers: {}, data: '' });
        request.mockResolvedValueOnce(mediaResponse);
        await service.download('https://x.com/user/status/456');
        expect(request.mock.calls[2][0].headers).toMatchObject({ Cookie: '' });
        expect(request.mock.calls[3][0].headers).toMatchObject({ Cookie: '' });
    });

    it('returns a controlled failure for Cloudflare challenges', async () => {
        request.mockResolvedValueOnce({ status: 200, headers: {}, data: '<title>Just a moment...</title>' });
        await expect(new TwitterService().download('https://x.com/user/status/123'))
            .rejects.toMatchObject({ statusCode: 503 });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not expose transport details on failure', async () => {
        request.mockRejectedValueOnce(new Error('socket failure secret-cookie-value'));
        await expect(new TwitterService().download('https://x.com/user/status/123'))
            .rejects.toMatchObject({ statusCode: 502, message: 'Unable to contact the Twitter download provider. Try again later.' });
    });
});
