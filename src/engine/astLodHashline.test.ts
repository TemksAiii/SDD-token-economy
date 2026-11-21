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
