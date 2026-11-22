import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHashlinePatch,
  extractAstSkeleton,
  formatWithHashlines,
  renderAstLodView,
} from './astLodHashline';
import { DEMO_SAMPLE_PYTHON_FILE } from '../data/demoFixtures';

test('formatWithHashlines prefixes every line with L{n}#{hash3}', () => {
  const { lines } = formatWithHashlines('alpha\nbeta');
  assert.equal(lines.length, 2);
  assert.match(lines[0].formatted, /^L1#[0-9a-f]{3}: alpha$/);
  assert.match(lines[1].formatted, /^L2#[0-9a-f]{3}: beta$/);
});

test('applyHashlinePatch succeeds on matching anchors and rejects stale hashes', () => {
  const source = 'line one\nline two\nline three';
  const { lines } = formatWithHashlines(source);

  const okRes = applyHashlinePatch(source, {
    startLine: 2,
    startHash: lines[1].hash,
    endLine: 2,
    endHash: lines[1].hash,
    replacement: 'line TWO patched',
  });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.updatedContent, 'line one\nline TWO patched\nline three');

  const badRes = applyHashlinePatch(source, {
    startLine: 2,
    startHash: 'fff',
    endLine: 2,
    endHash: lines[1].hash,
    replacement: 'should fail',
  });
  assert.equal(badRes.ok, false);
  assert.match(badRes.error ?? '', /Anchor mismatch/);
  assert.equal(badRes.updatedContent, source);
});

test('AST-LOD1 skeleton reduces Python source tokens while preserving class/def signatures', () => {
  const skeleton = extractAstSkeleton(DEMO_SAMPLE_PYTHON_FILE, 'python', 'rate_limiter.py');
  assert.match(skeleton, /class RateLimitStore:/);
  assert.match(skeleton, /async def consume/);
  const view = renderAstLodView('rate_limiter.py', DEMO_SAMPLE_PYTHON_FILE, 'python', 'LOD1');
  assert.ok(view.lodTokens < view.rawTokens);
  assert.ok(view.reductionPct > 30);
});

test('AST-LOD1 skeleton preserves TypeScript class methods and interface properties while folding bodies', () => {
  const tsCode = `export interface IdempotencyRecord<T> {
  payloadHash: string;
  value: T;
  expiresAt: number;
}

export class IdempotencyGuard {
  private readonly store = new Map<string, IdempotencyRecord<unknown>>();
  constructor(private readonly ttlMs = 60_000) {}

  // @spec:REQ-01
  async execute<T>(key: string, payloadHash: string, handler: () => Promise<T> | T, nowMs = Date.now()): Promise<T> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > nowMs) {
      return existing.value as T;
    }
    const result = await handler();
    this.store.set(key, { payloadHash, value: result, expiresAt: nowMs + this.ttlMs });
    return result;
  }
}`;
  const skeleton = extractAstSkeleton(tsCode, 'typescript', 'idempotencyGuard.ts');
  assert.match(skeleton, /export interface IdempotencyRecord<T>/);
  assert.match(skeleton, /payloadHash: string;/);
  assert.match(skeleton, /export class IdempotencyGuard/);
  assert.match(skeleton, /async execute<T>\(/);
  assert.ok(!skeleton.includes('this.store.set'));
  const view = renderAstLodView('idempotencyGuard.ts', tsCode, 'typescript', 'LOD1');
  assert.ok(view.lodTokens < view.rawTokens);

  const multiLineClass = `export class TokenBucketRateLimiter {
  constructor(
    private readonly capacity = 30,
    private readonly refillPerSec = 2
  ) {}

  resolveKey(apiKey?: string, ip?: string): { key: string; limit: number } {
    if (apiKey) return { key: apiKey, limit: this.capacity };
    return { key: ip || '127.0.0.1', limit: 20 };
  }

  consume(
    path: string,
    apiKey?: string
  ): { status: number } {
    const resolved = this.resolveKey(apiKey);
    return { status: path === '/healthz' ? 200 : resolved.limit > 0 ? 200 : 429 };
  }
}`;
  const multiSkeleton = extractAstSkeleton(multiLineClass, 'typescript', 'rateLimiter.ts');
  assert.match(multiSkeleton, /constructor\(/);
  assert.match(multiSkeleton, /resolveKey\(/);
  assert.match(multiSkeleton, /consume\(/);
  assert.ok(!multiSkeleton.includes('this.resolveKey(apiKey)'));
});

test('TSX AST keeps multiline contracts and re-exports, folding JSX and preserving original anchors', () => {
  const source = `export {
  encode as publicEncode,
} from './codec';
export const Component = (
  props: { label: string },
) => <b>{props.label}</b>;
export default function render() {
  const ignored = /https?:\\/\\//;
  return <Component label="test" />;
}`;
  const skeleton = extractAstSkeleton(source, 'typescript', 'component.tsx');
  assert.match(skeleton, /encode as publicEncode/);
  assert.match(skeleton, /props: \{ label: string \}/);
  assert.match(skeleton, /export default function render\(\)/);
  assert.doesNotMatch(skeleton, /ignored|<Component|<b>/);
  const anchor = formatWithHashlines(source).lines[4];
  assert.ok(skeleton.includes(`L5#${anchor.hash}:`));
});

test('malformed TS and unsupported languages retain full anchored source', () => {
  const malformed = 'export const x = (\nconst unrelated = 3;';
  assert.equal(extractAstSkeleton(malformed, 'typescript', 'bad.ts'), formatWithHashlines(malformed).formatted);
  const unknown = 'opaque content without recognizable symbols';
  assert.equal(extractAstSkeleton(unknown, 'go', 'unrecognized.go'), formatWithHashlines(unknown).formatted);
});
