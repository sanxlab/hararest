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

it('falls back to public yt-dlp metadata when SnapInsta fails and keeps the best complete MP4', async () => {
  const snapError = Object.assign(new Error('failed'), { stderr: '{"message":"Video is private"}' });
  mockExecFile.mockImplementation((file: string, args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (args[0].endsWith('.py')) return callback(snapError, '', '');
    expect(args).toContain('--ignore-config');
    expect(args).not.toContain('--cookies');
    expect(args.at(-1)).toBe('https://www.instagram.com/reel/DgCTwqAClhW/');
    expect(options).toMatchObject({ timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    callback(null, JSON.stringify({ formats: [
      { url: 'https://cdn.example.com/low.mp4', ext: 'mp4', width: 360, height: 640, vcodec: 'h264', acodec: 'aac' },
      { url: 'https://cdn.example.com/silent.mp4', ext: 'mp4', width: 1080, height: 1920, vcodec: 'h264', acodec: 'none' },
      { url: 'https://cdn.example.com/best.mp4', ext: 'mp4', width: 720, height: 1280, vcodec: 'h264', acodec: 'aac', filesize: 2048 },
    ] }), '');
  });
  const result = await new InstagramService().getMediaInfo('https://instagram.com/reel/DgCTwqAClhW/?tracking=ignored');
  expect(result.videos).toEqual([{ url: 'https://cdn.example.com/best.mp4', size: 2048, fSize: '2.0 KB' }]);
  expect(result.photos).toEqual([]);
  expect(mockExecFile).toHaveBeenCalledTimes(2);
});

it('reports restricted content without leaking extractor output and releases its slot', async () => {
  mockExecFile.mockImplementation((_file: string, args: string[], _options: object, callback: (error: Error, stdout: string, stderr: string) => void) => {
    callback(Object.assign(new Error('signed URL should not escape'), { stderr: args[0].endsWith('.py') ? '{"message":"private"}' : "This content isn't available to everyone: It can't be seen by certain audiences." }), '', '');
  });
  const service = new InstagramService();
  for (let i = 0; i < 2; i++) {
    await expect(service.getMediaInfo('https://instagram.com/reel/test/')).rejects.toMatchObject({ statusCode: 404, message: 'Media Instagram tidak tersedia untuk akses publik.' });
  }
});

it('bounds concurrent extractor processes', async () => {
  let finish!: (error: Error | null, stdout: string, stderr: string) => void;
  mockExecFile.mockImplementation((_file: string, _args: string[], _options: object, callback: typeof finish) => { finish = callback; });
  const service = new InstagramService();
  const first = service.getMediaInfo('https://instagram.com/p/123/');
  await expect(service.getMediaInfo('https://instagram.com/p/456/')).rejects.toMatchObject({ statusCode: 503 });
  finish(null, JSON.stringify({ status: 'ok', media_links: [{ url: 'https://cdn.example.com/video.mp4', text: 'Download Video' }] }), '');
  await expect(first).resolves.toMatchObject({ videos: [expect.any(Object)] });
});
