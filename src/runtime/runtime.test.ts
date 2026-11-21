import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveConfinedPath, RUNS_ROOT, WORKSPACE_ROOT } from './pathGuard';
import {
  copyRepoSnapshot,
  detectRepoOnDisk,
  inspectGitContext,
  readOpenSpecBundleFromDisk,
} from './repoFs';
import { runLocalPreReviewGate } from './localGateRunner';
import { extractAstSkeleton, formatWithHashlines } from '../engine/astLodHashline';
import { compressTestLog } from '../engine/outputCompressor';
import { parseOpenSpecBundle, sliceSpecForTask } from '../engine/specSlicer';
import { runRealAbWorktreeBenchmark } from './abWorktreeRunner';

test('resolveConfinedPath blocks path traversal outside workspace', () => {
  assert.throws(() => resolveConfinedPath('../../etc/passwd'), /escapes workspace/);
});

test('detectRepoOnDisk auto-detects TypeScript, Python, Go, and Java repos on disk', () => {
  const ts = detectRepoOnDisk('benchmarks/orders-ts');
  const py = detectRepoOnDisk('benchmarks/orders-py');
  const go = detectRepoOnDisk('benchmarks/edge-go');
  const java = detectRepoOnDisk('benchmarks/billing-java');

  assert.equal(ts.language, 'typescript');
  assert.ok(ts.isolationCapability === 'git_worktree' || ts.isolationCapability === 'snapshot_copy');
  assert.equal(ts.testRunnerKind, 'node_test');
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
  const compressed = compressTestLog(tapFail, 'node_test', { exitCode: 1 });
  assert.ok(!compressed.compressed.includes('ok 1 - passes'));
  assert.ok(!compressed.compressed.includes('node:internal/test_runner'));
  assert.match(compressed.compressed, /ERR_ASSERTION/);
  assert.ok(!compressed.compressed.includes('ALL TESTS GREEN'));
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
  const { listSavedRuns } = await import('./abWorktreeRunner');

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

const FINAL_GUARD_TS = `// @spec:REQ-01 @spec:REQ-02 @spec:REQ-03
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyGuard {
  private readonly store = new Map<string, { payloadHash: string; value: unknown; expiresAt: number }>();
  constructor(private readonly ttlMs = 60_000) {}

  async execute<T>(
    key: string,
    payloadHash: string,
    handler: () => Promise<T> | T,
    nowMs = Date.now()
  ): Promise<T> {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > nowMs) {
      if (existing.payloadHash !== payloadHash) {
        throw new IdempotencyConflictError('Payload mismatch for idempotency key');
      }
      return existing.value as T;
    }
    const value = await handler();
    this.store.set(key, { payloadHash, value, expiresAt: nowMs + this.ttlMs });
    return value;
  }
}
`;

const STEP1_GUARD_TS = `// @spec:REQ-01
export class IdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyGuard {
  private readonly store = new Map<string, { payloadHash: string; value: unknown; expiresAt: number }>();
  constructor(private readonly ttlMs = 60_000) {}

  async execute<T>(
    key: string,
    payloadHash: string,
    handler: () => Promise<T> | T,
    nowMs = Date.now()
  ): Promise<T> {
    const existing = this.store.get(key);
    if (existing) {
      return existing.value as T;
    }
    const value = await handler();
    this.store.set(key, { payloadHash, value, expiresAt: nowMs + this.ttlMs });
    return value;
  }
}
`;

const STEP4_WEBHOOK_TS = `import crypto from 'node:crypto';

// @spec:REQ-04
export function signWebhookPayload(secret: string, payload: string, timestampSec: number): string {
  const signed = \`\${timestampSec}.\${payload}\`;
  return crypto.createHmac('sha256', secret).update(signed).digest('hex');
}
`;

const FINAL_WEBHOOK_TS = `import crypto from 'node:crypto';

// @spec:REQ-04
export function signWebhookPayload(secret: string, payload: string, timestampSec: number): string {
  const signed = \`\${timestampSec}.\${payload}\`;
  return crypto.createHmac('sha256', secret).update(signed).digest('hex');
}

// @spec:REQ-05
export function verifyWebhookSignature(
  secret: string,
  payload: string,
  timestampSec: number,
  signatureHex: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300
): boolean {
  if (Math.abs(nowSec - timestampSec) > toleranceSec) return false;
  const expected = signWebhookPayload(secret, payload, timestampSec);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHex, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// @spec:REQ-06
export function computeRetryDelayMs(attempt: number, baseMs = 250, maxMs = 10_000): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(maxMs, exp);
}
`;

const STEP7_TEST_TS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyConflictError, IdempotencyGuard } from '../src/idempotency/idempotencyGuard.ts';

// @spec:REQ-01 @spec:REQ-02 @spec:REQ-03
test('IdempotencyGuard replays cached result, rejects conflicts, and expires after TTL', async () => {
  const guard = new IdempotencyGuard(100);
  let calls = 0;
  const first = await guard.execute('k1', 'hash-a', () => {
    calls++;
    return { ok: true, n: calls };
  }, 1000);
  const second = await guard.execute('k1', 'hash-a', () => {
    calls++;
    return { ok: true, n: calls };
  }, 1050);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);

  await assert.rejects(
    () => guard.execute('k1', 'hash-b', () => ({ ok: false }), 1060),
    IdempotencyConflictError
  );

  const afterTtl = await guard.execute('k1', 'hash-b', () => {
    calls++;
    return { ok: true, n: calls };
  }, 1200);
  assert.equal(calls, 2);
  assert.equal(afterTtl.n, 2);
});
`;

const FINAL_TEST_TS = `${STEP7_TEST_TS}
import {
  computeRetryDelayMs,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../src/webhooks/webhookSigner.ts';

// @spec:REQ-04 @spec:REQ-05 @spec:REQ-06
test('webhook signing, timing-safe verification, and backoff delay work per spec', () => {
  const sig = signWebhookPayload('sec', '{"id":1}', 1000);
  assert.equal(sig.length, 64);
  assert.equal(verifyWebhookSignature('sec', '{"id":1}', 1000, sig, 1100, 300), true);
  assert.equal(verifyWebhookSignature('sec', '{"id":1}', 1000, sig.replace(/^./, sig[0] === 'a' ? 'b' : 'a'), 1100, 300), false);
  assert.equal(verifyWebhookSignature('sec', '{"id":1}', 1000, sig, 2000, 300), false);
  assert.equal(computeRetryDelayMs(1, 200, 1000), 200);
  assert.equal(computeRetryDelayMs(3, 200, 1000), 800);
  assert.equal(computeRetryDelayMs(6, 200, 1000), 1000);
});
`;

function extractLod0Lines(prompt: string, filePath: string): string {
  const marker = `### EXISTING TARGET FILE (edit via hashline_patches ONLY): ${filePath}\n`;
  const idx = prompt.indexOf(marker);
  if (idx === -1) return '';
  const rest = prompt.slice(idx + marker.length);
  const nextSection = rest.indexOf('\n[');
  return (nextSection === -1 ? rest : rest.slice(0, nextSection)).trim();
}

function createScriptedCompatServer() {
  const guardPhase1 = STEP1_GUARD_TS;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as {
        messages?: Array<{ role: string; content: string }>;
      };
      const sys = parsed.messages?.[0]?.content || '';
      const user = parsed.messages?.[1]?.content || '';
      const promptTokens = Math.max(10, Math.ceil((sys.length + user.length) / 4));

      let content = '{}';
      const isBaseline =
        sys.includes('continuous single session') ||
        sys.includes('strict code reviewer') ||
        user.includes('[FULL OPENSPEC]') ||
        user.includes('Review the full OpenSpec') ||
        user.includes('Verify all requirements');

      if (isBaseline) {
        if (user.includes('Execute task TSK-01') || user.includes('Execute task TSK-02') || user.includes('Execute task TSK-03')) {
          content = JSON.stringify({
            edits: [{ path: 'src/idempotency/idempotencyGuard.ts', content: FINAL_GUARD_TS }],
          });
        } else if (user.includes('Execute task TSK-04') || user.includes('Execute task TSK-05') || user.includes('Execute task TSK-06')) {
          content = JSON.stringify({
            edits: [{ path: 'src/webhooks/webhookSigner.ts', content: FINAL_WEBHOOK_TS }],
          });
        } else if (user.includes('Execute task TSK-07') || user.includes('Execute task TSK-08')) {
          content = JSON.stringify({
            edits: [{ path: 'tests/idempotency_webhooks.test.ts', content: FINAL_TEST_TS }],
          });
        } else if (sys.includes('strict code reviewer')) {
          content = JSON.stringify({ approved: true, issues: [], edits: [] });
        } else {
          content = JSON.stringify({ plan: ['Implement all 8 tasks'], risks: [] });
        }
      } else {
        // SpecTrim micro-session using Hashline patches for existing files
        if (user.includes('Proposal:') && user.includes('Task IDs:')) {
          content = JSON.stringify({ glossary: ['IdempotencyGuard'], contracts: ['execute'] });
        } else if (user.includes('[TASK_TARGET]\nTSK-01:')) {
          content = JSON.stringify({
            files: [{ path: 'src/idempotency/idempotencyGuard.ts', content: guardPhase1 }],
            exported_symbol: 'IdempotencyGuard.execute',
          });
        } else if (user.includes('[TASK_TARGET]\nTSK-02:') || user.includes('[TASK_TARGET]\nTSK-03:')) {
          const rawLod = extractLod0Lines(user, 'src/idempotency/idempotencyGuard.ts');
          const lodLines = rawLod.split('\n');
          const firstMatch = lodLines[0]?.match(/^L(\d+)#([0-9a-f]+):/);
          const lastMatch = lodLines[lodLines.length - 1]?.match(/^L(\d+)#([0-9a-f]+):/);
          if (firstMatch && lastMatch) {
            content = JSON.stringify({
              hashline_patches: [
                {
                  path: 'src/idempotency/idempotencyGuard.ts',
                  startLine: Number(firstMatch[1]),
                  startHash: firstMatch[2],
                  endLine: Number(lastMatch[1]),
                  endHash: lastMatch[2],
                  replacement: FINAL_GUARD_TS,
                },
              ],
            });
          } else {
            content = JSON.stringify({ files: [{ path: 'src/idempotency/idempotencyGuard.ts', content: FINAL_GUARD_TS }] });
          }
        } else if (user.includes('[TASK_TARGET]\nTSK-04:')) {
          content = JSON.stringify({
            files: [{ path: 'src/webhooks/webhookSigner.ts', content: STEP4_WEBHOOK_TS }],
            exported_symbol: 'signWebhookPayload',
          });
        } else if (user.includes('[TASK_TARGET]\nTSK-05:') || user.includes('[TASK_TARGET]\nTSK-06:')) {
          const rawLod = extractLod0Lines(user, 'src/webhooks/webhookSigner.ts');
          const lodLines = rawLod.split('\n');
          const firstMatch = lodLines[0]?.match(/^L(\d+)#([0-9a-f]+):/);
          const lastMatch = lodLines[lodLines.length - 1]?.match(/^L(\d+)#([0-9a-f]+):/);
          if (firstMatch && lastMatch) {
            content = JSON.stringify({
              hashline_patches: [
                {
                  path: 'src/webhooks/webhookSigner.ts',
                  startLine: Number(firstMatch[1]),
                  startHash: firstMatch[2],
                  endLine: Number(lastMatch[1]),
                  endHash: lastMatch[2],
                  replacement: FINAL_WEBHOOK_TS,
                },
              ],
            });
          }
        } else if (user.includes('[TASK_TARGET]\nTSK-07:')) {
          content = JSON.stringify({
            files: [{ path: 'tests/idempotency_webhooks.test.ts', content: STEP7_TEST_TS }],
          });
        } else if (user.includes('[TASK_TARGET]\nTSK-08:')) {
          const rawLod = extractLod0Lines(user, 'tests/idempotency_webhooks.test.ts');
          const lodLines = rawLod.split('\n');
          const lastRaw = lodLines[lodLines.length - 1] ?? '';
          const lastMatch = lastRaw.match(/^L(\d+)#([0-9a-f]+):\s?(.*)$/);
          if (lastMatch) {
            content = JSON.stringify({
              hashline_patches: [
                {
                  path: 'tests/idempotency_webhooks.test.ts',
                  startLine: Number(lastMatch[1]),
                  startHash: lastMatch[2],
                  endLine: Number(lastMatch[1]),
                  endHash: lastMatch[2],
                  replacement: `${lastMatch[3]}\n${FINAL_TEST_TS.slice(STEP7_TEST_TS.length)}`,
                },
              ],
            });
          }
        } else if (sys.includes('delta code reviewer')) {
          content = JSON.stringify({ approved: true, notes: ['Verified'], hashline_patches: [], files: [] });
        } else {
          content = JSON.stringify({ verified: true });
        }
      }

      const completionTokens = Math.max(5, Math.ceil(content.length / 4));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })
      );
    });
  });
  return server;
}

test('runRealAbWorktreeBenchmark supports nested git repos (git_worktree) and non-git snapshots (snapshot_copy) end-to-end', async () => {
  const tmpBase = path.join(WORKSPACE_ROOT, '.tmp-ab-test-' + Date.now());
  const parentGitDir = path.join(tmpBase, 'parent-git-repo');
  const nestedSubpath = 'apps/orders';
  const nestedRepoDir = path.join(parentGitDir, nestedSubpath);
  const snapshotRepoDir = path.join(tmpBase, 'plain-snapshot-repo');

  const srcBenchmark = path.join(WORKSPACE_ROOT, 'benchmarks', 'orders-ts');
  copyRepoSnapshot(srcBenchmark, nestedRepoDir);
  copyRepoSnapshot(srcBenchmark, snapshotRepoDir);

  // Initialize git ONLY in parentGitDir so nestedRepoDir has .git in a parent directory
  execFileSync('git', ['init'], { cwd: parentGitDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: parentGitDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: parentGitDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: parentGitDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init nested repo'], { cwd: parentGitDir, stdio: 'ignore' });
  const expectedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: parentGitDir,
    encoding: 'utf8',
  }).trim();

  const nestedGitCtx = inspectGitContext(nestedRepoDir);
  assert.equal(nestedGitCtx.isGitRepo, true);
  assert.equal(nestedGitCtx.repoSubpath, nestedSubpath);
  assert.equal(nestedGitCtx.headCommit, expectedHead);

  const server = createScriptedCompatServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');

  const prevUrl = process.env.OPENAI_COMPAT_BASE_URL;
  const prevKey = process.env.OPENAI_COMPAT_API_KEY;
  const prevModel = process.env.OPENAI_COMPAT_MODEL;

  const createdRunIds: string[] = [];

  try {
    process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${addr.port}`;
    process.env.OPENAI_COMPAT_API_KEY = 'local-test-key';
    process.env.OPENAI_COMPAT_MODEL = 'scripted-test-model';

    // 1. Nested Git Repo (git_worktree)
    const nestedReport = await runRealAbWorktreeBenchmark({
      repoPath: path.relative(WORKSPACE_ROOT, nestedRepoDir),
      changeId: 'add-idempotency-and-webhooks',
      provider: 'openai_compat',
      model: 'scripted-test-model',
      maxReviewIters: 2,
    });
    createdRunIds.push(nestedReport.manifest.runId);

    assert.equal(nestedReport.manifest.isolationMode, 'git_worktree');
    assert.equal(nestedReport.manifest.baseCommit, expectedHead);
    assert.equal(nestedReport.manifest.repoSubpath, nestedSubpath);
    assert.equal(nestedReport.optimized.testsPassed, true);
    assert.equal(nestedReport.optimized.lintPassed, true);
    assert.equal(nestedReport.optimized.reqCoveragePct, 100);
    assert.equal(nestedReport.qualityParityPassed, true);
    assert.ok((nestedReport.savings.totalTokensPct ?? 0) > 30);
    assert.ok((nestedReport.savings.completionTokensPct ?? 0) > 0);
    assert.match(nestedReport.optimizedDiff, /src\/idempotency\/idempotencyGuard\.ts/);

    // 2. Non-Git Snapshot Copy Repo (snapshot_copy)
    const snapReport = await runRealAbWorktreeBenchmark({
      repoPath: path.relative(WORKSPACE_ROOT, snapshotRepoDir),
      changeId: 'add-idempotency-and-webhooks',
      provider: 'openai_compat',
      model: 'scripted-test-model',
      maxReviewIters: 2,
    });
    createdRunIds.push(snapReport.manifest.runId);

    assert.equal(snapReport.manifest.isolationMode, 'snapshot_copy');
    assert.match(snapReport.manifest.baseCommit, /^snapshot:[0-9a-f]{12}$/);
    assert.ok(snapReport.manifest.snapshotHash && snapReport.manifest.snapshotHash.length === 64);
    assert.ok(snapReport.limitations.some((l) => l.includes('snapshot_copy')));
    assert.equal(snapReport.optimized.testsPassed, true);
    assert.equal(snapReport.optimized.lintPassed, true);
    assert.equal(snapReport.optimized.reqCoveragePct, 100);
    assert.equal(snapReport.qualityParityPassed, true);
    assert.ok((snapReport.savings.totalTokensPct ?? 0) > 30);
    assert.ok((snapReport.savings.completionTokensPct ?? 0) > 0);
    assert.match(snapReport.optimizedDiff, /diff --git a\/src\/idempotency\/idempotencyGuard\.ts b\/src\/idempotency\/idempotencyGuard\.ts/);
  } finally {
    server.close();
    if (prevUrl === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
    else process.env.OPENAI_COMPAT_BASE_URL = prevUrl;
    if (prevKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = prevKey;
    if (prevModel === undefined) delete process.env.OPENAI_COMPAT_MODEL;
    else process.env.OPENAI_COMPAT_MODEL = prevModel;

    for (const rid of createdRunIds) {
      fs.rmSync(path.join(RUNS_ROOT, rid), { recursive: true, force: true });
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

