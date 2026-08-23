import supertest from 'supertest';
import app from '../app';

describe('Instagram Module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/instagram', () => {
        it('should return 400 if url is missing', async () => {
            const response = await supertest(app).get('/api/instagram');
            expect(response.status).toBe(400);
        });

        it('should return 403 for a disallowed instagram url', async () => {
            const response = await supertest(app).get('/api/instagram?url=https://google.com');
            expect(response.status).toBe(403);
        });
    });
});
