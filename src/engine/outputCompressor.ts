import { estimateTokens, shortBlockHash } from './tokens';

export type TestRunnerKind = 'pytest' | 'vitest' | 'go_test';

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

export function compressTestLog(
  rawLog: string,
  runner: TestRunnerKind = 'pytest'
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
    const trimmed = line.trim();

    // Strip ANSI escape codes & progress indicators
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '');

    if (/^\s*(PASSED|ok\s+|\.\.\.\s+ok|✓|\s*\[[0-9/]+\]|platform |rootdir:|collecting|cachedir:|plugins:)/.test(clean)) {
      continue;
    }

    if (
      /^(FAILED|FAIL|AssertionError|E\s+assert|Error:|panic:|---\s+FAIL:|×\s+|Expected:|Received:)/.test(
        trimmed
      ) ||
      trimmed.includes('FAILED ') ||
      trimmed.includes('AssertionError')
    ) {
      inFailureBlock = true;
      failureContextBudget = 12;
      if (/^(FAILED|---\s+FAIL:|×\s+)/.test(trimmed)) {
        detectedFailures.push(trimmed);
      }
      kept.push(clean);
      continue;
    }

    if (inFailureBlock) {
      // Skip noisy third-party site-packages / node_modules stack frames
      if (
        clean.includes('site-packages/') ||
        clean.includes('node_modules/') ||
        clean.includes('/usr/lib/')
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
      /\d+\s+(passed|failed)|Test Files\s+\d+|FAIL\s+\w+|PASS\s+\w+|short test summary/i.test(
        trimmed
      )
    ) {
      kept.push(clean);
    }
  }

  if (kept.length === 0) {
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
