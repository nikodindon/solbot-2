export interface BucketStats {
  acquired: number;
  waited: number;
  totalWaitMs: number;
  rejected: number;
}

/**
 * Token bucket rate limiter. `acquire()` returns when a token is available.
 * Used to stay strictly under Jupiter's keyless limit (0.5 RPS) or the Free tier (1 RPS).
 */
export class TokenBucket {
  private available: number;
  private last: number;
  readonly stats: BucketStats = { acquired: 0, waited: 0, totalWaitMs: 0, rejected: 0 };

  constructor(
    private readonly rps: number,
    private readonly burst = Math.max(1, Math.ceil(rps)),
  ) {
    this.available = burst;
    this.last = Date.now();
  }

  refill(): void {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed > 0) {
      this.available = Math.min(this.burst, this.available + (elapsed * this.rps) / 1000);
      this.last = now;
    }
  }

  tryAcquire(): boolean {
    this.refill();
    if (this.available >= 1) {
      this.available -= 1;
      this.stats.acquired += 1;
      return true;
    }
    return false;
  }

  /** Milliseconds (>=0) until a token is (likely) available. */
  waitTimeMs(): number {
    this.refill();
    if (this.available >= 1) {return 0;}
    return Math.max(1, ((1 - this.available) / this.rps) * 1000);
  }

  reject(): void {
    this.stats.rejected += 1;
  }
}
