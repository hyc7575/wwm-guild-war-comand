/** Token bucket: `ratePerSec` tokens/second, burst capacity == ratePerSec. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSec: number,
    now: number,
  ) {
    this.tokens = ratePerSec;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.ratePerSec, this.tokens + (elapsed / 1000) * this.ratePerSec);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Counts rate-limit violations; the count resets after `decayMs` without a new violation. */
export class ViolationCounter {
  private n = 0;
  private last = 0;
  constructor(private readonly decayMs: number) {}
  hit(now: number): number {
    if (this.n > 0 && now - this.last > this.decayMs) this.n = 0;
    this.last = now;
    return ++this.n;
  }
}

/** Best-effort clientCmdId from a raw frame that failed validation (so the error can be an ack). */
export function peekClientCmdId(data: string): string | undefined {
  try {
    const v = JSON.parse(data) as { clientCmdId?: unknown };
    return typeof v?.clientCmdId === 'string' && v.clientCmdId.length >= 1 && v.clientCmdId.length <= 64
      ? v.clientCmdId
      : undefined;
  } catch {
    return undefined;
  }
}

/** stt.* traffic is budgeted separately from command requests. */
export const bucketKind = (type: string | undefined): 'stt' | 'cmd' =>
  type === 'stt.feed' || type === 'stt.status' ? 'stt' : 'cmd';
