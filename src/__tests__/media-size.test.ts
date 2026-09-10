import fetch from 'node-fetch';
import * as dns from 'dns/promises';
import { getMediaSize, bytesToSize } from '../utils/mediaSize';
import { publicLookup } from '../utils/publicAgent';

jest.mock('node-fetch');
const mockFetch = fetch as unknown as jest.Mock;
const lookup = dns.lookup as jest.Mock;
beforeEach(() => {
  mockFetch.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

it.each(['-100', 'NaN', '123abc', null])('normalizes invalid content length %s to zero', async (length) => {
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => length } });
  await expect(getMediaSize('https://cdn.example.com/video.mp4')).resolves.toBe(0);
});

it('does not probe a private media URL', async () => {
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(getMediaSize('http://localhost/private')).resolves.toBe(0);
  expect(mockFetch).not.toHaveBeenCalled();
});

it('checks DNS again at socket connection time', async () => {
  lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
  const result = new Promise((resolve) => publicLookup('cdn.example.com', { all: true }, (error) => resolve(error)));
  await expect(result).resolves.toBeInstanceOf(Error);
});

it('provides both socket lookup result shapes', async () => {
  const all = new Promise((resolve) => publicLookup('cdn.example.com', { all: true }, (_error, addresses) => resolve(addresses)));
  await expect(all).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  const one = new Promise((resolve) => publicLookup('cdn.example.com', {}, (_error, address, family) => resolve([address, family])));
  await expect(one).resolves.toEqual(['93.184.216.34', 4]);
});

it('formats unusual sizes without invalid units', () => {
  expect(bytesToSize(-1)).toBe('0 B');
  expect(bytesToSize(Infinity)).toBe('0 B');
  expect(bytesToSize(1024)).toBe('1.0 KB');
  expect(bytesToSize(1024 ** 6)).toMatch(/ TB$/);
});
