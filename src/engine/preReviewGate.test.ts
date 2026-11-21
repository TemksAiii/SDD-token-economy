import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreReviewGate } from './preReviewGate';
import { DEMO_GATE_FILES, DEMO_OPENSPEC_BUNDLE } from '../data/demoWorkspace';

test('runPreReviewGate passes at 0 LLM tokens when all checks are green', () => {
  const res = runPreReviewGate({
    bundle: DEMO_OPENSPEC_BUNDLE,
    files: DEMO_GATE_FILES,
    testsPassing: true,
    lintErrors: [],
  });
  assert.equal(res.passed, true);
  assert.equal(res.gateTokens, 0);
  assert.equal(res.uncoveredReqsInCode.length, 0);
  assert.equal(res.uncoveredReqsInTests.length, 0);
  assert.equal(res.uncheckedTasks.length, 0);
});

test('runPreReviewGate catches missing @spec:REQ-07 test and unchecked tasks for 0 tokens', () => {
  const brokenFiles = DEMO_GATE_FILES.map((f) =>
    f.isTest
      ? { ...f, content: f.content.replace('@spec:REQ-07', '') }
      : f
  );
  const brokenBundle = {
    ...DEMO_OPENSPEC_BUNDLE,
    tasksMd: DEMO_OPENSPEC_BUNDLE.tasksMd.replace('- [x] [TSK-07]', '- [ ] [TSK-07]'),
  };

  const res = runPreReviewGate({
    bundle: brokenBundle,
    files: brokenFiles,
    testsPassing: false,
    failingTestSnippet: 'AssertionError in test_spool_fallback_on_sink_error',
    lintErrors: ['src/audit/audit_logger.py:42 unused import'],
  });

  assert.equal(res.passed, false);
  assert.equal(res.gateTokens, 0);
  assert.deepEqual(res.uncoveredReqsInTests, ['REQ-07']);
  assert.deepEqual(res.uncheckedTasks, ['TSK-07']);
  assert.match(res.conciseReport, /GATE BLOCKED/);
});
