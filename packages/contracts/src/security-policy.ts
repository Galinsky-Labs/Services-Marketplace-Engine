export const SECURITY_POLICY_CONTRACT_VERSION = 1 as const;

/** Response headers every HTTP adapter must send. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

export const REQUEST_LIMITS = Object.freeze({
  maximumBodyBytes: 256 * 1024,
  maximumUrlLength: 2_048,
  maximumHeaderValueLength: 8_192,
  requestTimeoutMs: 15_000,
});

export interface RateLimiter {
  /** Returns true when the request may proceed and consumes one token. */
  take(key: string): boolean;
}

/** Token bucket per key with a bounded key table (oldest keys evicted first). */
export function createRateLimiter(options: {readonly capacity: number;
  readonly refillPerSecond: number; readonly maximumKeys: number;
  readonly now: () => number}): RateLimiter {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1 ||
    !(options.refillPerSecond > 0) || !Number.isSafeInteger(options.maximumKeys) ||
    options.maximumKeys < 1) throw new RangeError('invalid rate limiter options');
  const buckets = new Map<string, {tokens: number; updatedAt: number}>();
  return {
    take(key: string): boolean {
      const now = options.now();
      const bucket = buckets.get(key) ?? {tokens: options.capacity, updatedAt: now};
      buckets.delete(key);
      const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
      bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
      bucket.updatedAt = now;
      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;
      buckets.set(key, bucket);
      while (buckets.size > options.maximumKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      return allowed;
    },
  };
}
