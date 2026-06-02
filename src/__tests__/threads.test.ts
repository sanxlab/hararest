import supertest from 'supertest';
import app from '../app';

const originalFetch = global.fetch;
const mockedFetch = jest.fn();

const createFetchResponse = (body: string, headers: Record<string, string> = {}) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
        get: (name: string) => headers[name.toLowerCase()] || null
    },
    text: jest.fn().mockResolvedValue(body)
});

describe('Threads Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        global.fetch = mockedFetch as unknown as typeof fetch;
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    describe('GET /api/threads/download', () => {
        it('should return media items for valid Threads URL', async () => {
            const originalUrl = 'https://cdn.example.com/video.mp4';
            const payload = Buffer.from(JSON.stringify({ url: originalUrl })).toString('base64url');
            const downloadUrl = `https://threadster.app/api/download?token=header.${payload}.sig`;

            mockedFetch
                .mockResolvedValueOnce(createFetchResponse('<html></html>', { 'set-cookie': 'session=abc; Path=/' }))
                .mockResolvedValueOnce(createFetchResponse(`
                    <html>
                        <body>
                            <div class="download__items_tabs__item" data-index="0">Video</div>
                            <div class="download_item" data-index="0">
                                <img src="https://cdn.example.com/thumb.jpg" />
                                <div class="download__item__profile_pic">
                                    <span>@threaduser</span>
                                    <img src="https://cdn.example.com/avatar.jpg" />
                                </div>
                                <div class="download__item__caption__text">Hello Threads</div>
                                <a class="download__item__download_btn" href="${downloadUrl}">Download</a>
                            </div>
                        </body>
                    </html>
                `));

            const response = await supertest(app).get('/api/threads/download?url=https://threads.net/@user/post/123');

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.source_url).toBe('https://threads.net/@user/post/123');
            expect(response.body.data.threadster_url).toBe('https://threadster.app/download');
            expect(response.body.data.count).toBe(1);
            expect(response.body.data.items[0]).toEqual({
                index: 0,
                label: 'Video',
                media_type: 'video',
                username: '@threaduser',
                caption: 'Hello Threads',
                thumbnail_url: 'https://cdn.example.com/thumb.jpg',
                profile_picture_url: 'https://cdn.example.com/avatar.jpg',
                download_url: downloadUrl,
                original_media_url: originalUrl
            });
        });

        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/threads/download');
            expect(response.status).toBe(400);
        });

        it('should return 400 for non-Threads URL', async () => {
            const response = await supertest(app).get('/api/threads/download?url=https://google.com/test');
            expect(response.status).toBe(400);
        });
    });
});
