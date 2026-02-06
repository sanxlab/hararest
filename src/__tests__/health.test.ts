import supertest from 'supertest';
import app from '../app';

describe('Health Check Endpoint', () => {
    it('should return a 200 status and the current date', async () => {
        const response = await supertest(app).get('/health');

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('success');
        expect(response.body.message).toBe('Server is healthy');
    });
});
