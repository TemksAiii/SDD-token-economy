import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfinedPath } from './pathGuard';
import { detectRepoOnDisk, readOpenSpecBundleFromDisk } from './repoFs';
import { runLocalPreReviewGate } from './localGateRunner';
import { extractAstSkeleton } from '../engine/astLodHashline';
import { compressTestLog } from '../engine/outputCompressor';
import { parseOpenSpecBundle, sliceSpecForTask } from '../engine/specSlicer';

test('resolveConfinedPath blocks path traversal outside workspace', () => {
  assert.throws(() => resolveConfinedPath('../../etc/passwd'), /escapes workspace/);
});

test('detectRepoOnDisk auto-detects TypeScript, Python, Go, and Java repos on disk', () => {
  const ts = detectRepoOnDisk('benchmarks/orders-ts');
  const py = detectRepoOnDisk('benchmarks/orders-py');
  const go = detectRepoOnDisk('benchmarks/edge-go');
  const java = detectRepoOnDisk('benchmarks/billing-java');

  assert.equal(ts.language, 'typescript');
  assert.equal(ts.isGitRepo, true);
  assert.ok(ts.changes.includes('add-rate-limit-and-audit'));
  assert.ok(ts.changes.includes('add-idempotency-and-webhooks'));

  assert.equal(py.language, 'python');
  assert.equal(py.testRunnerKind, 'unittest');
  assert.equal(go.language, 'go');
  assert.equal(java.language, 'java');
});

test('readOpenSpecBundleFromDisk parses real pending change add-idempotency-and-webhooks', () => {
  const bundle = readOpenSpecBundleFromDisk('benchmarks/orders-ts', 'add-idempotency-and-webhooks');
  const graph = parseOpenSpecBundle(bundle);
  assert.equal(graph.requirements.length, 6);
  assert.equal(graph.designSections.length, 4);
  assert.equal(graph.tasks.length, 8);
  assert.equal(graph.tasks.filter((t) => !t.completed).length, 8);

  const slice = sliceSpecForTask(bundle, 'TSK-04', ['TSK-01', 'TSK-02', 'TSK-03']);
  assert.deepEqual(
    slice.requirements.map((r) => r.id),
    ['REQ-04']
  );
  assert.ok(slice.reductionPct > 40);
});

test('runLocalPreReviewGate executes real tests and tsc on benchmarks/orders-ts and passes at 0 LLM tokens', async () => {
  const res = await runLocalPreReviewGate('benchmarks/orders-ts', 'add-rate-limit-and-audit');
  assert.equal(res.provenance, 'measured_local');
  assert.equal(res.testExitCode, 0);
  assert.equal(res.lintExitCode, 0);
  assert.equal(res.gate.passed, true);
  assert.equal(res.gate.gateTokens, 0);
});

test('runLocalPreReviewGate executes real Python unittest on benchmarks/orders-py and passes', async () => {
  const res = await runLocalPreReviewGate('benchmarks/orders-py', 'add-rate-limit-and-audit');
  assert.equal(res.testExitCode, 0);
  assert.equal(res.gate.passed, true);
});

test('extractAstSkeleton handles Java and compressTestLog handles node:test TAP failures', () => {
  const javaCode = `package com.acme;\npublic class RateLimiter {\n  // @spec:REQ-01\n  public synchronized boolean tryAcquire(String key) {\n    return true;\n  }\n}`;
  const skel = extractAstSkeleton(javaCode, 'java', 'RateLimiter.java');
  assert.match(skel, /public class RateLimiter/);
  assert.match(skel, /public synchronized boolean tryAcquire/);

  const tapFail = `TAP version 13\nok 1 - passes\nnot ok 2 - fails\n  ---\n  error: AssertionError [ERR_ASSERTION]: 1 == 2\n  at node:internal/test_runner/test:10\n  ...\n# tests 2\n# pass 1\n# fail 1`;
  const compressed = compressTestLog(tapFail, 'node_test');
  assert.ok(!compressed.compressed.includes('ok 1 - passes'));
  assert.ok(!compressed.compressed.includes('node:internal/test_runner'));
  assert.match(compressed.compressed, /ERR_ASSERTION/);
});

test('getRealRepoPortabilityDetails inspects real TS, Python, Go, and Java repos on disk', async () => {
  const { getRealRepoPortabilityDetails } = await import('./repoFs');
  const repos = [
    'benchmarks/orders-ts',
    'benchmarks/orders-py',
    'benchmarks/edge-go',
    'benchmarks/billing-java',
  ];
  for (const r of repos) {
    const details = getRealRepoPortabilityDetails(r);
    assert.equal(details.provenance, 'measured_local');
    assert.ok(details.manifestContent.length > 0);
    assert.ok(details.astSkeletonPreview.length > 0);
    assert.ok(details.rawTokens >= details.skeletonTokens || details.rawTokens > 0);
  }
});

test('runRealAbWorktreeBenchmark refuses to fabricate usage when provider keys are unset', async () => {
  const { getProviderStatus } = await import('./llmProvider');
  const { listSavedRuns, runRealAbWorktreeBenchmark } = await import('./abWorktreeRunner');

  const status = getProviderStatus();
  assert.ok(Array.isArray(status.availableModels));
  assert.ok(Array.isArray(listSavedRuns()));

  if (status.defaultProvider === 'none') {
    await assert.rejects(
      () =>
        runRealAbWorktreeBenchmark({
          repoPath: 'benchmarks/orders-ts',
          changeId: 'add-idempotency-and-webhooks',
        }),
      /Провайдер LLM не настроен/
    );
  }
});

