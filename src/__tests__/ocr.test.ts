import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import sharp from 'sharp';
import { OcrService } from '../modules/ocr/ocr.service';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
const mockedSpawn = spawn as jest.Mock;
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: jest.Mock };
let image: Buffer;

beforeAll(async () => {
  image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
});

beforeEach(() => {
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() });
  mockedSpawn.mockReturnValue(child);
});
afterEach(() => {
  child.emit('close', 0);
  jest.useRealTimers();
});

function startOcr() {
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  mockedSpawn.mockImplementationOnce(() => { resolveStarted(); return child; });
  return { result: new OcrService().extractText(image), started };
}

it('collects OCR output', async () => {
  const { result, started } = startOcr();
  await started;
  child.stdout.emit('data', Buffer.from(' hello\n'));
  child.emit('close', 0);
  await expect(result).resolves.toBe('hello');
});

it('handles missing engine without an unhandled process error', async () => {
  const { result, started } = startOcr();
  await started;
  child.emit('error', new Error('ENOENT'));
  child.emit('close', -2);
  await expect(result).rejects.toMatchObject({ statusCode: 500 });
});

it('handles EPIPE without crashing the server', async () => {
  const { result, started } = startOcr();
  await started;
  child.stdin.emit('error', new Error('EPIPE'));
  await expect(result).rejects.toMatchObject({ statusCode: 502 });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('terminates a hung OCR process', async () => {
  jest.useFakeTimers();
  const { result, started } = startOcr();
  await started;
  const assertion = expect(result).rejects.toMatchObject({ statusCode: 504 });
  jest.advanceTimersByTime(60000);
  await assertion;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('reports unreadable images', async () => {
  const { result, started } = startOcr();
  await started;
  child.emit('close', 1);
  await expect(result).rejects.toMatchObject({ statusCode: 422 });
});

it('rejects malformed, vector, and excessive pixel images before spawning OCR', async () => {
  const excessive = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#ffffff' } }).png().toBuffer();
  for (const data of [Buffer.from('invalid'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'), excessive]) {
    await expect(new OcrService().extractText(data)).rejects.toMatchObject({ statusCode: 422 });
  }
  expect(mockedSpawn).not.toHaveBeenCalled();
});

it('shares capacity across service instances and releases it after processes close', async () => {
  const first = startOcr();
  await first.started;
  const second = startOcr();
  await second.started;
  await expect(new OcrService().extractText(image)).rejects.toMatchObject({ statusCode: 503 });
  expect(mockedSpawn).toHaveBeenCalledTimes(2);
  child.emit('close', 0);
  await Promise.all([first.result, second.result]);
  const next = startOcr();
  await next.started;
  child.emit('close', 0);
  await expect(next.result).resolves.toBe('');
});

it('keeps capacity reserved after timeout until the terminated processes close', async () => {
  jest.useFakeTimers();
  const first = startOcr();
  await first.started;
  const second = startOcr();
  await second.started;
  const assertions = [expect(first.result).rejects.toMatchObject({ statusCode: 504 }), expect(second.result).rejects.toMatchObject({ statusCode: 504 })];
  jest.advanceTimersByTime(60000);
  await Promise.all(assertions);
  await expect(new OcrService().extractText(image)).rejects.toMatchObject({ statusCode: 503 });
  expect(mockedSpawn).toHaveBeenCalledTimes(2);
});
