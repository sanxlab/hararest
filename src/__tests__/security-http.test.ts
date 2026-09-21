import express from 'express';
import supertest from 'supertest';
import * as dns from 'dns/promises';
import { assertPublicUrl, isSafeIP } from '../middlewares/ssrf.middleware';
import { errorHandler } from '../middlewares/error.middleware';
import { publicLookup } from '../utils/publicAgent';
import { AppError } from '../utils/AppError';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn() },
}));

const lookup = dns.lookup as jest.Mock;

beforeEach(() => {
  lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

afterEach(() => jest.restoreAllMocks());

describe('Public address validation', () => {
  it.each([
    '127.0.0.1', '169.254.169.254', '10.0.0.1', '100.64.0.1',
    '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '100::1',
    '2001::1', '2001:2::1', '2001:10::1', '2001:20::1', '2001:db8::1',
    '2002:7f00:1::1', '3ffe::1', '3fff::1', '4000::1',
    'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2606:4700::1111%lo',
  ])('rejects private, transition, and reserved destination %s', (address) => {
    expect(isSafeIP(address)).toBe(false);
  });

  it.each(['1.1.1.1', '93.184.216.34', '::ffff:1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows public address %s', (address) => {
    expect(isSafeIP(address)).toBe(true);
  });

  it('rejects a DNS answer containing both public and private addresses', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: 'fec0::1', family: 6 },
    ]);
    await expect(assertPublicUrl('https://example.com/')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('checks DNS again when opening the socket and blocks a changed private answer', async () => {
    await assertPublicUrl('https://example.com/');
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const connectedAddress = new Promise((resolve, reject) => {
      publicLookup('example.com', { all: true }, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    });
    await expect(connectedAddress).rejects.toThrow('restricted IP address');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('returns all validated addresses for connection family fallback', async () => {
    const addresses = [
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '1.1.1.1', family: 4 },
    ];
    lookup.mockResolvedValue(addresses);
    const result = new Promise((resolve, reject) => {
      publicLookup('example.com', { all: true }, (error, resolved) => {
        if (error) reject(error);
        else resolve(resolved);
      });
    });
    await expect(result).resolves.toEqual(addresses);
  });
});

function requestWithError(error: unknown) {
  const app = express();
  app.get('/', (_req, _res, next) => next(error));
  app.use(errorHandler);
  return supertest(app).get('/');
}

describe('HTTP error responses', () => {
  beforeEach(() => jest.replaceProperty(process.env, 'NODE_ENV', 'production'));

  it.each([
    new Error('ENOENT /private/runtime/cookies.txt'),
    new AppError('Command failed: --password=secret-value', 500),
    'unhandled private failure',
  ])('hides internal failure details in production', async (error) => {
    const response = await requestWithError(error);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'error', message: 'Internal Server Error' });
  });

  it('preserves intentional validation errors', async () => {
    const response = await requestWithError(new AppError('URL is required.', 400));
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ status: 'fail', message: 'URL is required.' });
  });

  it('preserves intentional service-unavailable guidance', async () => {
    const response = await requestWithError(new AppError('The player is full. Please retry later.', 503));
    expect(response.status).toBe(503);
    expect(response.body.message).toBe('The player is full. Please retry later.');
  });

  it('does not echo malformed request contents from JSON parser errors', async () => {
    const app = express();
    app.use(express.json());
    app.post('/', (_req, res) => res.sendStatus(204));
    app.use(errorHandler);
    const response = await supertest(app).post('/').type('json').send('{"password":"private-value",}');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ status: 'fail', message: 'Bad Request' });
  });

  it('keeps diagnostic details when explicitly running in development', async () => {
    jest.replaceProperty(process.env, 'NODE_ENV', 'development');
    const response = await requestWithError(new Error('Development diagnostics'));
    expect(response.body.message).toBe('Development diagnostics');
    expect(response.body.stack).toContain('Development diagnostics');
  });
});
