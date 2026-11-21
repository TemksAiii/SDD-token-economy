import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTestRunOutput,
  compressGitDiff,
  compressTestLog,
  deduplicateFileReads,
} from './outputCompressor';
import { DEMO_RAW_GIT_DIFF, DEMO_RAW_PYTEST_LOG } from '../data/demoFixtures';

test('compressTestLog strips passing tests and site-packages while retaining failure assertion', () => {
  const res = compressTestLog(DEMO_RAW_PYTEST_LOG, 'pytest', { exitCode: 1 });
  assert.ok(res.reductionPct > 40, `Expected >40% log reduction, got ${res.reductionPct}%`);
  assert.match(res.compressed, /test_spool_fallback_on_sink_error/);
  assert.match(res.compressed, /AssertionError/);
  assert.ok(!res.compressed.includes('site-packages/pytest_asyncio'));
  assert.ok(!res.compressed.includes('test_create_order PASSED'));
  assert.ok(!res.compressed.includes('ALL TESTS GREEN'));
});

test('compressTestLog never reports ALL TESTS GREEN on non-zero exitCode or ESM/syntax crash', () => {
  const crashLog = `node:internal/errors:496\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/wt/src/idempotency/idempotencyGuard.ts'\n# tests 0\n# fail 0`;
  const analysis = analyzeTestRunOutput(crashLog, 1);
  assert.equal(analysis.passed, false);
  assert.equal(analysis.hasFailureSignals, true);

  const res = compressTestLog(crashLog, 'node_test', { exitCode: 1 });
  assert.ok(!res.compressed.includes('ALL TESTS GREEN'));
  assert.match(res.compressed, /ERR_MODULE_NOT_FOUND|TESTS FAILED/);

  // Even when a runner exits non-zero with unrecognized output, never say ALL TESTS GREEN
  const silentFail = compressTestLog('ok 1 - first test\nUnexpected termination', 'node_test', {
    exitCode: 2,
  });
  assert.ok(!silentFail.compressed.includes('ALL TESTS GREEN'));
  assert.match(silentFail.compressed, /TESTS FAILED \(exit 2\)/);
});

test('compressGitDiff marks unchanged files with 304 Not Modified stub', () => {
  const res = compressGitDiff(DEMO_RAW_GIT_DIFF, {
    'src/api/orders_router.py': '552a99c',
  });
  assert.match(res.compressed, /@UNCHANGED:552a99c/);
  assert.ok(res.compressedTokens < res.rawTokens);
});

test('deduplicateFileReads skips re-charging identical file contents', () => {
  const res = deduplicateFileReads([
    { step: 1, path: 'src/a.py', content: DEMO_RAW_PYTEST_LOG },
    { step: 2, path: 'src/a.py', content: DEMO_RAW_PYTEST_LOG },
    { step: 3, path: 'src/a.py', content: DEMO_RAW_PYTEST_LOG },
  ]);
  assert.equal(res.events[0].status, 'full_read');
  assert.equal(res.events[1].status, 'dedup_cached');
  assert.equal(res.events[2].status, 'dedup_cached');
  assert.ok(res.reductionPct > 60);
});
