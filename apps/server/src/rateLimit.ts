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
