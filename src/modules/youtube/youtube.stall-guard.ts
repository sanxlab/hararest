import logger from '../../utils/logger';

export type DownloadOutcome = 'ok' | 'network_timeout' | 'other';

// A long-lived dyno can reach a state where YouTube still answers metadata
// requests but every media download stalls until it times out. A fresh dyno
// recovers, so after several consecutive stalled downloads the process asks
// for a graceful shutdown and lets the platform start a new one.
export class StallGuard {
  private consecutive = 0;
  private triggered = false;

  constructor(
    // 0 disables the guard.
    private readonly threshold: number,
    // Never restart a young process: if downloads stall right after boot, a
    // restart did not help and repeating it would only cause a crash loop.
    private readonly minUptimeMs: number,
    private readonly restart: () => void = () => process.kill(process.pid, 'SIGTERM'),
    private readonly uptimeMs: () => number = () => process.uptime() * 1000,
  ) {}

  record(outcome: DownloadOutcome): void {
    if (outcome === 'ok') {
      this.consecutive = 0;
      return;
    }
    // Other failures (private video, bad format, …) say nothing about the
    // media connection, so they neither count nor clear the streak.
    if (outcome !== 'network_timeout') return;
    this.consecutive++;
    if (this.threshold <= 0 || this.triggered || this.consecutive < this.threshold) return;
    if (this.uptimeMs() < this.minUptimeMs) return;
    this.triggered = true;
    logger.warn('YouTube downloads keep stalling; restarting the process to recover', {
      consecutiveTimeouts: this.consecutive,
    });
    this.restart();
  }
}
