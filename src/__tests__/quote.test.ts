import axios from 'axios';
import * as dns from 'dns/promises';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import supertest from 'supertest';
import app from '../app';
import { QuoteService } from '../modules/quote/quote.service';
import { loadQuoteImage } from '../modules/quote/quote.images';

jest.mock('axios');
jest.mock('../middlewares/ratelimit.middleware', () => ({
  apiLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  downloadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  jobStatusLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const get = axios.get as jest.Mock;
const lookup = dns.lookup as jest.Mock;
const payload = () => ({
  type: 'quote',
  format: 'png',
  backgroundColor: '#FFFFFF',
  width: 512,
  height: 512,
  scale: 2,
  messages: [
    {
      avatar: true,
      from: { id: 123, name: 'Kotonehara', photo: { url: '' } },
      text: 'Halo dunia 👋',
      entities: null,
    },
  ],
});

beforeEach(() => {
  get.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

it('renders a real PNG using the existing Kotonehara response contract without network calls', async () => {
  const response = await supertest(app).post('/api/quote/generate').send(payload());
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
  const buffer = Buffer.from(response.body.result.image, 'base64');
  const info = await sharp(buffer).metadata();
  expect(info.format).toBe('png');
  expect(info.width).toBeGreaterThan(50);
  expect(info.height).toBeLessThanOrEqual(512);
  expect(buffer.length).toBeGreaterThan(1000);
  expect(get).not.toHaveBeenCalled();
}, 30000);

it('renders dark quotes with an attachment, avatar, formatted text, and reply', async () => {
  const png = await sharp({ create: { width: 80, height: 60, channels: 4, background: '#ff9900' } })
    .png()
    .toBuffer();
  get.mockResolvedValue({ status: 200, headers: {}, data: png });
  const input = {
    ...payload(),
    backgroundColor: '#1F2C34',
    messages: [
      {
        avatar: true,
        from: { id: 8, name: 'Nama', photo: { url: 'https://example.com/avatar.png' } },
        text: 'Halo tebal',
        entities: [{ type: 'bold', offset: 5, length: 5 }],
        media: { url: 'https://example.com/image.png' },
        replyMessage: { name: 'Teman', text: 'Pesan awal', chatId: 0, entities: null },
      },
    ],
  };
  const response = await supertest(app).post('/api/quote').send(input);
  expect(response.status).toBe(200);
  expect(response.body.ok).toBe(true);
  expect((await sharp(Buffer.from(response.body.result.image, 'base64')).metadata()).format).toBe(
    'png',
  );
  expect(get).toHaveBeenCalledTimes(2);
}, 30000);

it.each([
  {},
  { ...payload(), scale: 99 },
  { ...payload(), messages: [] },
  { ...payload(), botToken: 'secret' },
  { ...payload(), messages: [{ ...payload().messages[0], text: '' }] },
  {
    ...payload(),
    messages: [{ ...payload().messages[0], entities: [{ type: 'bold', offset: 100, length: 2 }] }],
  },
  { ...payload(), messages: [{ ...payload().messages[0], media: { url: 'file:///etc/passwd' } }] },
  {
    ...payload(),
    messages: [
      {
        ...payload().messages[0],
        from: { id: 1, name: 'x', photo: { url: 'data:image/png;base64,abc' } },
      },
    ],
  },
])('rejects malformed or excessive quote requests', async (input) => {
  expect((await supertest(app).post('/api/quote/generate').send(input)).status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});

it('rejects private image addresses and redirects before opening a connection', async () => {
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(
    loadQuoteImage('http://localhost/image', AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(get).not.toHaveBeenCalled();
  lookup
    .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  get.mockResolvedValue({ status: 302, headers: { location: 'http://localhost/secret' } });
  await expect(
    loadQuoteImage('https://example.com/image', AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(get).toHaveBeenCalledTimes(1);
});

it('normalizes images to bounded PNGs and refuses SVG', async () => {
  get.mockResolvedValueOnce({
    status: 200,
    headers: {},
    data: await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#ff0000' } })
      .jpeg()
      .toBuffer(),
  });
  const image = await loadQuoteImage('https://example.com/photo.jpg', AbortSignal.timeout(1000));
  const info = await sharp(Buffer.from(image.split(',')[1], 'base64')).metadata();
  expect(info.width).toBe(1024);
  expect(info.format).toBe('png');
  get.mockResolvedValueOnce({
    status: 200,
    headers: {},
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
  });
  await expect(
    loadQuoteImage('https://example.com/image.svg', AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ statusCode: 400 });
});

it('rejects concurrent render requests without holding an unbounded queue', async () => {
  const service = new QuoteService();
  const first = service.generate(payload());
  await expect(service.generate(payload())).rejects.toMatchObject({ statusCode: 503 });
  expect((await first).image).toBeTruthy();
}, 30000);

it.each(['W'.repeat(4096), 'abc ' + 'W'.repeat(4092)])(
  'bounds long unbroken words in the upstream layout',
  async (text) => {
    const requireVendor = createRequire(__filename);
    const { prepareText } = requireVendor(
      '../../vendor/quote-api/utils/quote-generate/text-prepare',
    ) as {
      prepareText: (
        text: string,
        entities: unknown[],
        size: number,
        brand: string,
        telegram: unknown,
      ) => Promise<unknown>;
    };
    const { layoutText } = requireVendor(
      '../../vendor/quote-api/utils/quote-generate/text-layout',
    ) as {
      layoutText: (
        prepared: unknown,
        width: number,
        height: number,
      ) => { height: number; truncated: boolean };
    };
    const prepared = await prepareText(text, [], 24, 'apple', {});
    const layout = layoutText(prepared, 128, 128);
    expect(layout.height).toBeLessThanOrEqual(128);
    expect(layout.truncated).toBe(true);
  },
);

it('supports image-only quotes and WebP output', async () => {
  const png = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#00ccff' },
  })
    .png()
    .toBuffer();
  get.mockResolvedValue({ status: 200, headers: {}, data: png });
  const input = {
    ...payload(),
    format: 'webp',
    messages: [{ ...payload().messages[0], text: '', media: { url: 'https://example.com/photo' } }],
  };
  const result = await new QuoteService().generate(input);
  expect((await sharp(Buffer.from(result.image, 'base64')).metadata()).format).toBe('webp');
}, 30000);
