import supertest from 'supertest';
import app from '../app';
import axios from 'axios';
import * as dns from 'dns/promises';
import { AvscanService } from '../modules/avscan/avscan.service';

describe('AVScan Module', () => {
  describe('GET /api/avscan', () => {
    it('returns 400 when url parameter is missing', async () => {
      const response = await supertest(app).get('/api/avscan');
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('required');
    });

    it('returns 403 or 400 when url points to a private or restricted host', async () => {
      (dns.lookup as jest.Mock).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
      const response = await supertest(app).get('/api/avscan?url=http://127.0.0.1/test.jpg');
      expect([400, 403]).toContain(response.status);
    });

    it('rejects redirects that lead to a private host before invoking the scraper', async () => {
      const getSpy = jest.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 302,
        headers: { location: 'http://internal.example/secret.jpg' },
        data: new ArrayBuffer(0),
      });
      (dns.lookup as jest.Mock)
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);

      const response = await supertest(app).get('/api/avscan?url=https://example.com/image.jpg');

      expect(response.status).toBe(403);
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(getSpy.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false });
      getSpy.mockRestore();
    });
  });

  describe('POST /api/avscan', () => {
    it('returns 400 when request body is empty', async () => {
      const response = await supertest(app)
        .post('/api/avscan')
        .set('Content-Type', 'image/jpeg')
        .send(Buffer.alloc(0));
      expect(response.status).toBe(400);
    });

    it('returns search results when service resolves successfully', async () => {
      const mockResult = {
        results: [
          {
            video_code: 'FWAY-031',
            best_similarity: 92.5,
            best_timestamp: '00:44:50',
            best_thumb: 'https://avscan.cc/thumb/test/frame.webp',
            frames: [
              {
                image_name: 'FWAY-031_00-00-38.jpg',
                similarity: 92.5,
                timestamp: '00:44:50',
                thumb_url: 'https://avscan.cc/thumb/test/frame.webp',
              },
            ],
            watch_urls: {
              missav: 'https://missav.ai/en/FWAY-031',
              javdb: 'https://javdb.com/search?q=FWAY-031&f=all',
              javbus: 'https://www.javbus.com/FWAY-031',
              avscan_direct: 'https://avscan.cc/go/m/en/FWAY-031?s=r',
            },
          },
        ],
      };

      const spy = jest.spyOn(AvscanService.prototype, 'search').mockResolvedValue(mockResult);

      const fakeImage = Buffer.alloc(100, 0xff);
      const response = await supertest(app)
        .post('/api/avscan')
        .set('Content-Type', 'image/jpeg')
        .send(fakeImage);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].video_code).toBe('FWAY-031');

      spy.mockRestore();
    });

    it('returns 429 when upstream rate limit is hit', async () => {
      const spy = jest
        .spyOn(AvscanService.prototype, 'search')
        .mockRejectedValue(Object.assign(new Error('AVScan rate limit exceeded'), { statusCode: 429 }));

      const fakeImage = Buffer.alloc(100, 0xff);
      const response = await supertest(app)
        .post('/api/avscan')
        .set('Content-Type', 'image/jpeg')
        .send(fakeImage);

      expect(response.status).toBe(429);
      spy.mockRestore();
    });
  });
});
