jest.mock('cloudscraper', () => ({
    jar: jest.fn(),
    get: jest.fn(),
    post: jest.fn()
}));

import supertest from 'supertest';
import app from '../app';

const cloudscraper = require('cloudscraper') as {
    jar: jest.Mock;
    get: jest.Mock;
    post: jest.Mock;
};

describe('Twitter Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        cloudscraper.jar.mockReturnValue({});
    });

    describe('GET /api/twitter/download', () => {
        it('should return media links for valid X URL', async () => {
            cloudscraper.get.mockResolvedValueOnce(`
                <html>
                    <body>
                        <input name="csrfmiddlewaretoken" value="csrf-token" />
                        <input name="gql" value="gql-token" />
                    </body>
                </html>
            `);

            cloudscraper.post.mockResolvedValueOnce(`
                <html>
                    <body>
                        <a class="tw-btn" href="https://cdn.example/video-720.mp4" data-filename="720p: mp4">
                            Download 720p
                        </a>
                    </body>
                </html>
            `);

            const response = await supertest(app).get('/api/twitter/download?url=https://x.com/user/status/123');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.input_url).toBe('https://x.com/user/status/123');
            expect(response.body.data.media_links[0]).toEqual({
                label: 'Download 720p',
                quality: '720p',
                url: 'https://cdn.example/video-720.mp4'
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
