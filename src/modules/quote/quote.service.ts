import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AppError } from '../../utils/AppError';
import { loadQuoteImage } from './quote.images';
import { quoteSchema, QuotePayload, QuoteResult } from './quote.schema';

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const generate = require(workerData.renderer);
Promise.resolve(generate(workerData.payload)).then(result => {
  if (!result || result.error) throw new Error('Quote rendering failed');
  parentPort.postMessage(result);
}).catch(() => { parentPort.postMessage({ error: true }); });
`;
let busy = false;

export class QuoteService {
  async generate(input: unknown): Promise<QuoteResult> {
    const parsed = quoteSchema.safeParse(input);
    if (!parsed.success)
      throw new AppError(`Invalid quote payload: ${parsed.error.issues[0].message}`, 400);
    if (busy) throw new AppError('Quote renderer is busy. Try again shortly.', 503);
    busy = true;
    const started = Date.now();
    const signal = AbortSignal.timeout(12000);
    try {
      const payload = parsed.data;
      // Validate all input URLs before optional avatar failures may be ignored.
      for (const message of payload.messages) {
        if (message.from.photo.url) {
          try {
            message.from.photo.url = await loadQuoteImage(message.from.photo.url, signal);
          } catch (error) {
            if (error instanceof AppError && error.statusCode < 500) throw error;
            message.from.photo.url = '';
          }
        }
        if (message.media) message.media.url = await loadQuoteImage(message.media.url, signal);
      }
      return await this.render(payload, Math.max(1, 25000 - (Date.now() - started)));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Unable to load or render quote images.', 502);
    } finally {
      busy = false;
    }
  }

  private render(payload: QuotePayload, timeout: number): Promise<QuoteResult> {
    return new Promise((resolve, reject) => {
      // CPU work runs outside the Express event loop and is terminated on timeout.
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: { payload, renderer: path.resolve(__dirname, '../../../vendor/quote-api') },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      });
      let settled = false;
      const finish = (error?: AppError, result?: QuoteResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().then(
          () => {
            if (error) reject(error);
            else resolve(result!);
          },
          () => reject(new AppError('Unable to stop quote renderer.', 500)),
        );
      };
      const timer = setTimeout(
        () => finish(new AppError('Quote rendering timed out.', 504)),
        timeout,
      );
      worker.once('error', () => finish(new AppError('Quote rendering failed.', 500)));
      worker.once('exit', () => {
        if (!settled) finish(new AppError('Quote renderer stopped unexpectedly.', 500));
      });
      worker.once('message', (result: QuoteResult & { error?: boolean }) => {
        if (
          result.error ||
          typeof result.image !== 'string' ||
          !result.image ||
          result.image.length > 3_800_000
        ) {
          finish(new AppError('Quote renderer returned an invalid or oversized image.', 500));
        } else finish(undefined, result);
      });
    });
  }
}
