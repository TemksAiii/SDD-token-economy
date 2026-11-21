import { QuotaResult } from '../types';

export const BYPASS_PATHS = new Set(['/healthz', '/metrics']);

interface BucketEntry {
  tokens: number;
  lastRefillMs: number;
}

// @spec:REQ-01 @spec:REQ-02 @spec:REQ-03 @spec:REQ-04 @spec:REQ-05
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();

  constructor(
    private readonly capacity = 30,
    private readonly refillPerSec = 2,
    private readonly anonCapacity = 20
  ) {}

  resolveKey(apiKey?: string, ip?: string): { key: string; limit: number } {
    if (apiKey && apiKey.trim().length > 0) {
      return { key: `key:${apiKey.trim()}`, limit: this.capacity };
    }
    return { key: `ip:${ip || '127.0.0.1'}`, limit: this.anonCapacity };
  }

  shouldBypass(path: string): boolean {
    return BYPASS_PATHS.has(path);
  }

  consume(
    path: string,
    apiKey?: string,
    ip?: string,
    nowMs = Date.now()
  ): { status: number; headers: Record<string, string>; quota: QuotaResult } {
    if (this.shouldBypass(path)) {
      return {
        status: 200,
        headers: {},
        quota: { allowed: true, remaining: this.capacity, resetAfterSec: 0 },
      };
    }

    const { key, limit } = this.resolveKey(apiKey, ip);
    const prev = this.buckets.get(key) ?? { tokens: limit, lastRefillMs: nowMs };
    const elapsedSec = Math.max(0, (nowMs - prev.lastRefillMs) / 1000);
    const replenished = Math.min(limit, prev.tokens + elapsedSec * this.refillPerSec);

    if (replenished < 1) {
      const resetAfterSec = Math.max(1, Math.ceil((1 - replenished) / this.refillPerSec));
      this.buckets.set(key, { tokens: replenished, lastRefillMs: nowMs });
      return {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetAfterSec),
          'Retry-After': String(resetAfterSec),
        },
        quota: { allowed: false, remaining: 0, resetAfterSec },
      };
    }

    const nextTokens = replenished - 1;
    this.buckets.set(key, { tokens: nextTokens, lastRefillMs: nowMs });
    return {
      status: 200,
      headers: {
        'X-RateLimit-Remaining': String(Math.floor(nextTokens)),
        'X-RateLimit-Reset': '1',
      },
      quota: { allowed: true, remaining: Math.floor(nextTokens), resetAfterSec: 1 },
    };
  }
}
