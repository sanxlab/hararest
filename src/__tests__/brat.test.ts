import supertest from 'supertest';
import app from '../app';

// Mock the puppeteer utility
jest.mock('../utils/puppeteer', () => ({
    launchBrowser: jest.fn(),
}));

import { launchBrowser } from '../utils/puppeteer';

describe('Brat Module', () => {
    let mockPage: any;
    let mockBrowser: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockPage = {
            newPage: jest.fn(),
            goto: jest.fn(),
            click: jest.fn(),
            evaluate: jest.fn(),
            type: jest.fn(),
            waitForSelector: jest.fn().mockResolvedValue({
                screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
            }),
        };

        mockBrowser = {
            newPage: jest.fn().mockResolvedValue(mockPage),
            close: jest.fn(),
        };

        (launchBrowser as jest.Mock).mockResolvedValue(mockBrowser);
    });

    describe('GET /api/brat', () => {
        it('should return an image for valid text', async () => {
            const response = await supertest(app).get('/api/brat?text=helloworld');

            expect(response.status).toBe(200);
            expect(response.type).toBe('image/png');
            expect(launchBrowser).toHaveBeenCalled();
            expect(mockPage.goto).toHaveBeenCalledWith('https://www.bratgenerator.com/');
            expect(mockPage.type).toHaveBeenCalledWith('#textInput', 'helloworld');
        });

        it('should return 400 if text is missing', async () => {
            const response = await supertest(app).get('/api/brat');
            expect(response.status).toBe(400);
        });
    });
});
