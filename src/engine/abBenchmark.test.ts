import test from 'node:test';
import assert from 'node:assert/strict';
import { runAbBenchmark } from './abBenchmark';
import { analyzeRepoPortability } from './portability';
import { DEMO_REPO_PROBES } from '../data/demoWorkspace';

test('runAbBenchmark demonstrates >=55% savings on both small and large LLMs with 100% REQ parity', () => {
  const smallRun = runAbBenchmark({ modelTier: 'small', taskCount: 10, baselineReviewIters: 4 });
  const largeRun = runAbBenchmark({ modelTier: 'large', taskCount: 10, baselineReviewIters: 4 });

  assert.equal(smallRun.sameModelEnforced, true);
  assert.ok(smallRun.totals.totalSavingsPct >= 60, `Small LLM savings: ${smallRun.totals.totalSavingsPct}%`);
  assert.ok(largeRun.totals.totalSavingsPct >= 55, `Large LLM savings: ${largeRun.totals.totalSavingsPct}%`);
  assert.equal(smallRun.quality.optimizedReqCoveragePct, 100);
  assert.equal(smallRun.quality.optimizedTestsGreenPct, 100);
  assert.ok(
    smallRun.quality.optimizedFirstPassTaskRatePct > smallRun.quality.baselineFirstPassTaskRatePct
  );
  const lines = smallRun.metricsJsonl.split('\n');
  assert.ok(lines.length >= 25);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test('analyzeRepoPortability auto-detects Python, TypeScript, and Go without config overrides', () => {
  const results = DEMO_REPO_PROBES.map(analyzeRepoPortability);
  assert.deepEqual(
    results.map((r) => r.detectedLanguage),
    ['python', 'typescript', 'go']
  );
  for (const r of results) {
    assert.equal(r.zeroCodeRewriteRequired, true);
    assert.ok(r.skeletonTokens < r.rawTokens);
  }
});
