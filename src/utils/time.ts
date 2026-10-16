export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function utcDayKey(tms = Date.now()): string {
  return new Date(tms).toISOString().slice(0, 10);
}

export function nextUtcMidnight(tms = Date.now()): number {
  const d = new Date(tms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 86_400_000;
}

export class IntervalRunner {
  private stopped = false;
  constructor(
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
  ) {}

  start(): void {
    this.stopped = false;
    const loop = async (): Promise<void> => {
      while (!this.stopped) {
        try {
          await this.fn();
        } catch (err) {
          this.onError(err);
        }
        await sleep(this.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
  }
}
