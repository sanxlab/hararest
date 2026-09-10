import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import { OcrService } from '../modules/ocr/ocr.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
const mockedSpawn = spawn as jest.Mock;
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: jest.Mock };

beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() });
  mockedSpawn.mockReturnValue(child);
});
afterEach(() => jest.useRealTimers());

it('collects OCR output', async () => {
  const result = new OcrService().extractText(Buffer.from('image'));
  child.stdout.emit('data', Buffer.from(' hello\n'));
  child.emit('close', 0);
  await expect(result).resolves.toBe('hello');
});

it('handles missing engine without an unhandled process error', async () => {
  const result = new OcrService().extractText(Buffer.from('image'));
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -2);
  await expect(result).rejects.toMatchObject({ statusCode: 500 });
});

it('handles EPIPE without crashing the server', async () => {
  const result = new OcrService().extractText(Buffer.from('image'));
  child.stdin.emit('error', new Error('EPIPE'));
  await expect(result).rejects.toMatchObject({ statusCode: 502 });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('terminates a hung OCR process', async () => {
  jest.useFakeTimers();
  const result = new OcrService().extractText(Buffer.from('image'));
  const assertion = expect(result).rejects.toMatchObject({ statusCode: 504 });
  jest.advanceTimersByTime(60000);
  await assertion;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('reports unreadable images', async () => {
  const result = new OcrService().extractText(Buffer.from('image'));
  child.emit('close', 1);
  await expect(result).rejects.toMatchObject({ statusCode: 422 });
});
