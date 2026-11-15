import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/default';
import { MAX_COOKIE_FILE_BYTES, hasYoutubeLogin, isNetscapeCookieFile } from '../../config/cookies';
import { homeHelperConfigured, homeHelperRequest } from '../../utils/homeHelper';
import logger from '../../utils/logger';

const REFRESH_INTERVAL_MS = 30 * 60_000;
const MIN_RETRY_MS = 60_000;
const PUSH_DELAY_MS = 5 * 60_000;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// Keeps the yt-dlp cookie jar in sync with the private home helper:
// - pull: a cookie uploaded to the home server reaches Heroku without a
//   Config Var change or dyno restart;
// - push: cookies rotated by yt-dlp are written back, so a dyno restart does
//   not fall back to a stale session.
// The helper only accepts a push based on the version it currently holds
// (If-Match), so a manual upload on the home server always wins.
// Cookie content never appears in logs or errors.
export class HomeCookieSync {
  private pulling?: Promise<boolean>;
  private pushing?: Promise<void>;
  private lastPull = 0;
  // Version the helper holds, as far as this process knows.
  private remoteHash?: string;
  private timer?: NodeJS.Timeout;
  private pushTimer?: NodeJS.Timeout;

  constructor(
    private readonly target = config.youtube.cookiePath,
    private readonly minRetryMs = MIN_RETRY_MS,
    private readonly pushDelayMs = PUSH_DELAY_MS,
  ) {}

  start(intervalMs = REFRESH_INTERVAL_MS): void {
    if (!homeHelperConfigured() || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  // Pull. Resolves true only when a new, valid cookie file was written locally.
  refresh(): Promise<boolean> {
    if (!homeHelperConfigured()) return Promise.resolve(false);
    if (this.pulling) return this.pulling;
    if (Date.now() - this.lastPull < this.minRetryMs) return Promise.resolve(false);
    this.lastPull = Date.now();
    this.pulling = this.pull().finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  // Called after yt-dlp used the jar; batches write-backs.
  notifyLocalChange(): void {
    if (!homeHelperConfigured() || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined;
      void this.push();
    }, this.pushDelayMs);
    this.pushTimer.unref();
  }

  // Write back pending changes now, e.g. before the dyno stops.
  async flush(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = undefined;
      await this.push();
    } else {
      await this.pushing;
    }
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.pushTimer);
    this.timer = undefined;
    this.pushTimer = undefined;
  }

  push(): Promise<void> {
    if (!homeHelperConfigured()) return Promise.resolve();
    if (this.pushing) return this.pushing;
    this.pushing = this.upload().finally(() => { this.pushing = undefined; });
    return this.pushing;
  }

  private async pull(): Promise<boolean> {
    try {
      const response = await homeHelperRequest('GET', '/cookies', { timeout: 10_000, maxBytes: MAX_COOKIE_FILE_BYTES });
      if (response.status !== 200) {
        logger.warn('Home helper cookies unavailable', { reason: 'helper_status', status: response.status });
        return false;
      }
      const bytes = Buffer.from(response.data, 'utf8');
      if (!isNetscapeCookieFile(bytes)) {
        logger.warn('Home helper cookies rejected', { reason: 'invalid_format' });
        return false;
      }
      const hash = sha256(bytes);
      // Unchanged at home: keep the local jar, which may hold newer rotations.
      if (hash === this.remoteHash && fs.existsSync(this.target)) return false;
      await this.writeLocal(bytes);
      this.remoteHash = hash;
      logger.info('Home helper cookies updated');
      return true;
    } catch {
      logger.warn('Home helper cookies unavailable', { reason: 'request_failed' });
      return false;
    }
  }

  private async upload(): Promise<void> {
    // Without a known base version a push could clobber the home copy.
    if (!this.remoteHash) return;
    let bytes: Buffer;
    try {
      bytes = await fs.promises.readFile(this.target);
    } catch {
      return;
    }
    if (!isNetscapeCookieFile(bytes)) return;
    const hash = sha256(bytes);
    if (hash === this.remoteHash) return;
    if (!hasYoutubeLogin(bytes)) {
      logger.warn('Home helper cookies not saved', { reason: 'login_missing' });
      return;
    }
    try {
      const response = await homeHelperRequest('PUT', '/cookies', {
        body: bytes, timeout: 10_000, maxBytes: MAX_COOKIE_FILE_BYTES,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': `"${this.remoteHash}"` },
      });
      if (response.status === 200 || response.status === 204) {
        this.remoteHash = hash;
        logger.info('Home helper cookies saved');
      } else if (response.status === 412) {
        // A newer cookie was uploaded at home; adopt it instead.
        logger.info('Home helper cookies changed at home; pulling');
        this.lastPull = 0;
        await this.refresh();
      } else {
        logger.warn('Home helper cookies not saved', { reason: 'helper_status', status: response.status });
      }
    } catch {
      logger.warn('Home helper cookies not saved', { reason: 'request_failed' });
    }
  }

  private async writeLocal(bytes: Buffer): Promise<void> {
    const temporary = path.join(path.dirname(this.target), `.${path.basename(this.target)}.${process.pid}.tmp`);
    await fs.promises.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.promises.rename(temporary, this.target);
  }
}

export const homeCookieSync = new HomeCookieSync();
