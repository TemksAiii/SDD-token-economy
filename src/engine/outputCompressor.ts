import { estimateTokens, shortBlockHash } from './tokens';

export type TestRunnerKind = 'pytest' | 'unittest' | 'vitest' | 'node_test' | 'go_test' | 'junit';

export interface CompressedOutputResult {
  compressed: string;
  rawTokens: number;
  compressedTokens: number;
  reductionPct: number;
  strippedLines: number;
  totalLines: number;
  detectedFailures: string[];
}

export interface FileReadEvent {
  path: string;
  content: string;
  step: number;
}

export interface DeduplicatedReadsResult {
  events: Array<{
    step: number;
    path: string;
    status: 'full_read' | 'dedup_cached';
    tokensCharged: number;
    tokensSaved: number;
    hash: string;
  }>;
  totalRawTokens: number;
  totalOptimizedTokens: number;
  reductionPct: number;
}

export interface CompressTestLogOptions {
  exitCode?: number;
}

export interface TestRunAnalysis {
  passed: boolean;
  executedTests: number | null;
  failedTests: number;
  hasFailureSignals: boolean;
}

export function analyzeTestRunOutput(
  rawLog: string,
  exitCode: number
): TestRunAnalysis {
  const clean = rawLog.replace(/\x1b\[[0-9;]*m/g, '');
  let executedTests: number | null = null;
  let failedTests = 0;

  // node:test TAP summary: "# tests 5", "# pass 4", "# fail 1"
  const tapTotal = clean.match(/^#\s*tests\s+(\d+)/m);
  const tapFail = clean.match(/^#\s*fail\s+(\d+)/m);
  if (tapTotal) {
    executedTests = Number(tapTotal[1]);
  }
  if (tapFail) {
    failedTests = Number(tapFail[1]);
  }

  // python unittest: "Ran 3 tests in 0.001s"
  const unittestMatch = clean.match(/Ran\s+(\d+)\s+tests?\s+in/i);
  if (unittestMatch) {
    executedTests = Number(unittestMatch[1]);
  }
  const unittestFailed = clean.match(/FAILED\s*\((?:failures=(\d+))?(?:,\s*)?(?:errors=(\d+))?/i);
  if (unittestFailed) {
    failedTests += Number(unittestFailed[1] || 0) + Number(unittestFailed[2] || 0);
  }

  // pytest: "1 failed, 12 passed" or "12 passed"
  const pytestFail = clean.match(/(\d+)\s+failed/i);
  const pytestPass = clean.match(/(\d+)\s+passed/i);
  if (pytestFail || pytestPass) {
    const f = pytestFail ? Number(pytestFail[1]) : 0;
    const p = pytestPass ? Number(pytestPass[1]) : 0;
    executedTests = f + p;
    failedTests = Math.max(failedTests, f);
  }

  const hasFailureSignals =
    failedTests > 0 ||
    /^(?:FAILED|FAIL\b|not ok \d+|panic:|---\s+FAIL:|✖\s+|×\s+)/m.test(clean) ||
    /(?:AssertionError|ERR_ASSERTION|ERR_MODULE_NOT_FOUND|Error\s+\[ERR_|TypeError:|SyntaxError:|ReferenceError:|Transform failed|TSError|Cannot find module)/.test(
      clean
    );

  const zeroTestsExecuted = executedTests !== null && executedTests === 0;
  const passed = exitCode === 0 && failedTests === 0 && !hasFailureSignals && !zeroTestsExecuted;

  return {
    passed,
    executedTests,
    failedTests,
    hasFailureSignals,
  };
}

export function compressTestLog(
  rawLog: string,
  runner: TestRunnerKind = 'pytest',
  options: CompressTestLogOptions = {}
): CompressedOutputResult {
  const lines = rawLog.split(/\r?\n/);
  const totalLines = lines.length;
  const rawTokens = estimateTokens(rawLog);

  const kept: string[] = [];
  const detectedFailures: string[] = [];
  let inFailureBlock = false;
  let failureContextBudget = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
    const trimmed = clean.trim();

    const isExplicitFailure =
      /^(FAILED|FAIL\b|not ok \d+|AssertionError|ERR_ASSERTION|ERR_MODULE_NOT_FOUND|TypeError:|SyntaxError:|ReferenceError:|Transform failed|TSError|Cannot find module|Error:|Error\s+\[ERR_|panic:|---\s+FAIL:|✖\s+|×\s+|Expected:|Received:)/.test(
        trimmed
      ) ||
      trimmed.includes('FAILED ') ||
      trimmed.includes('AssertionError') ||
      trimmed.includes('ERR_ASSERTION') ||
      trimmed.includes('ERR_MODULE_NOT_FOUND') ||
      trimmed.includes('Transform failed') ||
      trimmed.includes('Cannot find module') ||
      /^#\s*fail\s+[1-9]\d*/i.test(trimmed);

    if (isExplicitFailure) {
      inFailureBlock = true;
      failureContextBudget = 12;
      if (
        /^(FAILED|not ok \d+|---\s+FAIL:|✖\s+|×\s+|TypeError:|SyntaxError:|ReferenceError:|Transform failed|Error)/.test(
          trimmed
        ) ||
        trimmed.includes('Cannot find module')
      ) {
        detectedFailures.push(trimmed);
      }
      kept.push(clean);
      continue;
    }

    if (
      /^\s*(PASSED|ok\s+\d+|ok\s+[^-]|✓|\s*\[[0-9/]+\]|platform |rootdir:|collecting|cachedir:|plugins:|TAP version|duration_ms:|type:\s*'test'|\.\.\.$)/.test(
        clean
      ) ||
      / \.\.\. ok$/.test(clean)
    ) {
      continue;
    }

    if (inFailureBlock) {
      // Skip noisy third-party site-packages / node_modules / internal node test_runner stack frames
      if (
        clean.includes('site-packages/') ||
        clean.includes('node_modules/') ||
        clean.includes('/usr/lib/') ||
        clean.includes('node:internal/test_runner')
      ) {
        continue;
      }
      if (trimmed === '' && failureContextBudget <= 0) {
        inFailureBlock = false;
        continue;
      }
      kept.push(clean);
      failureContextBudget--;
      continue;
    }

    // Keep final summary line
    if (
      /\d+\s+(passed|failed)|Test Files\s+\d+|FAIL\s+\w+|PASS\s+\w+|short test summary|# tests \d+|# pass \d+|# fail \d+|Ran \d+ tests? in/i.test(
        trimmed
      )
    ) {
      kept.push(clean);
    }
  }

  const exitFailed = typeof options.exitCode === 'number' && options.exitCode !== 0;
  const analysis = analyzeTestRunOutput(rawLog, options.exitCode ?? 0);

  // Never report ALL TESTS GREEN if exitCode != 0 or failure signals were present
  const onlyPassingSummary =
    kept.length === 0 ||
    (exitFailed && detectedFailures.length === 0 && kept.every((l) => /^#\s*(tests|pass|fail 0)/.test(l.trim())));

  if (exitFailed || analysis.hasFailureSignals || !analysis.passed) {
    if (onlyPassingSummary) {
      const nonEmptyTail = lines
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
        .filter((l) => l.trim().length > 0)
        .slice(-15);
      kept.length = 0;
      kept.push(
        `[${runner}: TESTS FAILED (exit ${options.exitCode ?? 'non-zero'}) — ${totalLines} log lines, tail:]`,
        ...nonEmptyTail
      );
      if (detectedFailures.length === 0 && nonEmptyTail.length > 0) {
        detectedFailures.push(nonEmptyTail[0].trim());
      }
    } else {
      kept.unshift(
        `[SpecTrim Log Compressor (${runner}, exit ${options.exitCode ?? 'fail'}): kept ${kept.length}/${totalLines} signal lines]`
      );
    }
  } else if (kept.length === 0) {
    kept.push(`[${runner}: ALL TESTS GREEN — ${totalLines} noisy log lines stripped]`);
  } else {
    kept.unshift(
      `[SpecTrim Log Compressor (${runner}): kept ${kept.length}/${totalLines} signal lines]`
    );
  }

  const compressed = kept.join('\n');
  const compressedTokens = estimateTokens(compressed);
  const reductionPct =
    rawTokens > 0
      ? Number((((rawTokens - compressedTokens) / rawTokens) * 100).toFixed(1))
      : 0;

  return {
    compressed,
    rawTokens,
    compressedTokens,
    reductionPct,
    strippedLines: Math.max(0, totalLines - kept.length + 1),
    totalLines,
    detectedFailures,
  };
}

export function compressGitDiff(
  rawDiff: string,
  previousIterationHashes: Record<string, string> = {}
): CompressedOutputResult {
  const lines = rawDiff.split(/\r?\n/);
  const totalLines = lines.length;
  const rawTokens = estimateTokens(rawDiff);

  const out: string[] = [];
  let currentFile = '';
  let skipUnchangedFile = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/b\/(.+)$/);
      currentFile = m ? m[1] : 'unknown';
      skipUnchangedFile = false;
      continue;
    }
    if (
      line.startsWith('index ') ||
      line.startsWith('--- a/') ||
      line.startsWith('+++ b/')
    ) {
      if (line.startsWith('+++ b/')) {
        const fileHash = previousIterationHashes[currentFile];
        if (fileHash) {
          out.push(`[FILE ${currentFile} @UNCHANGED:${fileHash} — 304 Not Modified]`);
          skipUnchangedFile = true;
        } else {
          out.push(`FILE: ${currentFile}`);
        }
      }
      continue;
    }

    if (skipUnchangedFile) continue;

    if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-')) {
      out.push(line);
    }
    // Unchanged context lines inside hunks are omitted unless crucial
  }

  const compressed =
    out.length > 0
      ? `[SpecTrim Delta Diff: ${out.length}/${totalLines} lines]\n${out.join('\n')}`
      : '[SpecTrim Delta Diff: 0 changes since last review]';

  const compressedTokens = estimateTokens(compressed);
  const reductionPct =
    rawTokens > 0
      ? Number((((rawTokens - compressedTokens) / rawTokens) * 100).toFixed(1))
      : 0;

  return {
    compressed,
    rawTokens,
    compressedTokens,
    reductionPct,
    strippedLines: Math.max(0, totalLines - out.length),
    totalLines,
    detectedFailures: [],
  };
}

export function deduplicateFileReads(reads: FileReadEvent[]): DeduplicatedReadsResult {
  const seenHashes = new Map<string, string>();
  let totalRawTokens = 0;
  let totalOptimizedTokens = 0;

  const events = reads.map((r) => {
    const hash = shortBlockHash(r.content);
    const rawTokens = estimateTokens(r.content);
    totalRawTokens += rawTokens;

    if (seenHashes.get(r.path) === hash) {
      const stubTokens = 12;
      totalOptimizedTokens += stubTokens;
      return {
        step: r.step,
        path: r.path,
        status: 'dedup_cached' as const,
        tokensCharged: stubTokens,
        tokensSaved: Math.max(0, rawTokens - stubTokens),
        hash,
      };
    }

    seenHashes.set(r.path, hash);
    totalOptimizedTokens += rawTokens;
    return {
      step: r.step,
      path: r.path,
      status: 'full_read' as const,
      tokensCharged: rawTokens,
      tokensSaved: 0,
      hash,
    };
  });

  const reductionPct =
    totalRawTokens > 0
      ? Number((((totalRawTokens - totalOptimizedTokens) / totalRawTokens) * 100).toFixed(1))
      : 0;

  return {
    events,
    totalRawTokens,
    totalOptimizedTokens,
    reductionPct,
  };
}
