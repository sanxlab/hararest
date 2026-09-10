import { execFile } from 'child_process';
import fetch from 'node-fetch';
import { InstagramService } from '../modules/instagram/instagram.service';

jest.mock('node-fetch');
jest.mock('child_process', () => {
  const mock = jest.fn();
  // Match execFile's real promisify adapter, which returns { stdout, stderr }.
  Object.assign(mock, {
    [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => new Promise((resolve, reject) => {
      mock(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  return { ...jest.requireActual('child_process'), execFile: mock };
});
const mockExecFile = execFile as unknown as jest.Mock;
const mockFetch = fetch as unknown as jest.Mock;

it('returns carousel photos and videos from the Python extractor', async () => {
  mockExecFile.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, JSON.stringify({ status: 'ok', media_links: [{ url: 'https://cdn.example.com/photo.jpg', text: 'Download Photo' }, { url: 'https://cdn.example.com/video.mp4', text: 'Download Video' }] }), '');
  });
  mockFetch.mockResolvedValue({ ok: true, headers: { get: () => '1024' } });
  const result = await new InstagramService().getMediaInfo('https://instagram.com/p/123/');
  expect(result.photos).toHaveLength(1);
  expect(result.videos).toHaveLength(1);
  expect(result.thumbnail).toBe('https://cdn.example.com/photo.jpg');
  expect(result.photos[0].fSize).toBe('1.0 KB');
});

it('handles empty extractor results', async () => {
  mockExecFile.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, '{"status":"ok","media_links":[]}', '');
  });
  await expect(new InstagramService().getMediaInfo('https://instagram.com/p/123/')).rejects.toMatchObject({ statusCode: 404 });
});
