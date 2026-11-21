import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compressGitDiff,
  compressTestLog,
  deduplicateFileReads,
} from './outputCompressor';
import { DEMO_RAW_GIT_DIFF, DEMO_RAW_PYTEST_LOG } from '../data/demoFixtures';

test('compressTestLog strips passing tests and site-packages while retaining failure assertion', () => {
  const res = compressTestLog(DEMO_RAW_PYTEST_LOG, 'pytest');
  assert.ok(res.reductionPct > 40, `Expected >40% log reduction, got ${res.reductionPct}%`);
  assert.match(res.compressed, /test_spool_fallback_on_sink_error/);
  assert.match(res.compressed, /AssertionError/);
  assert.ok(!res.compressed.includes('site-packages/pytest_asyncio'));
  assert.ok(!res.compressed.includes('test_create_order PASSED'));
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
