import fs from 'node:fs';
import path from 'node:path';
import { runPreReviewGate, PreReviewGateResult } from '../engine/preReviewGate';
import {
  analyzeTestRunOutput,
  compressTestLog,
  CompressedOutputResult,
} from '../engine/outputCompressor';
import { resolveConfinedPath } from './pathGuard';
import { collectRepoFiles, detectRepoOnDisk, readOpenSpecBundleFromDisk } from './repoFs';
import { runSafeCommand, splitCommandArgs } from './execUtils';

export interface LocalGateExecutionReport {
  repoPath: string;
  changeId: string;
  provenance: 'measured_local';
  gate: PreReviewGateResult;
  testCommand: string;
  testExitCode: number;
  testDurationMs: number;
  rawTestOutput: string;
  compressedTestLog: CompressedOutputResult;
  lintCommand: string;
  lintExitCode: number;
  lintDurationMs: number;
  rawLintOutput: string;
}

function expandTestGlobs(absRepo: string, args: string[]): string[] {
  const expanded: string[] = [];
  for (const arg of args) {
    if (arg === 'tests/*.test.ts') {
      const testsDir = path.join(absRepo, 'tests');
      if (fs.existsSync(testsDir)) {
        const files = fs
          .readdirSync(testsDir)
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => path.join('tests', f));
        if (files.length > 0) {
          expanded.push(...files);
          continue;
        }
      }
    }
    expanded.push(arg);
  }
  return expanded;
}

export async function runLocalPreReviewGate(
  repoInputPath: string,
  changeId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LocalGateExecutionReport> {
  const absRepo = resolveConfinedPath(repoInputPath);
  const info = detectRepoOnDisk(repoInputPath);
  const bundle = readOpenSpecBundleFromDisk(repoInputPath, changeId);
  const files = collectRepoFiles(absRepo);

  const testParts = splitCommandArgs(info.testCommand);
  const expandedTestArgs = expandTestGlobs(absRepo, testParts.args);
  const testRes = await runSafeCommand(testParts.bin, expandedTestArgs, absRepo, {
    timeoutMs: 45_000,
    signal: options.signal,
  });

  const testAnalysis = analyzeTestRunOutput(testRes.combined, testRes.exitCode);
  const compressedTestLog = compressTestLog(testRes.combined, info.testRunnerKind, {
    exitCode: testRes.exitCode,
  });

  const lintParts = splitCommandArgs(info.lintCommand);
  const lintRes = await runSafeCommand(lintParts.bin, lintParts.args, absRepo, {
    timeoutMs: 45_000,
    signal: options.signal,
  });

  const lintErrors =
    lintRes.exitCode === 0
      ? []
      : lintRes.combined
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0)
          .slice(0, 12);

  const gate = runPreReviewGate({
    bundle,
    files,
    testsPassing: testAnalysis.passed,
    failingTestSnippet: testAnalysis.passed ? undefined : compressedTestLog.compressed,
    lintErrors,
    verifySubstance: true,
  });

  return {
    repoPath: info.repoPath,
    changeId: bundle.changeId,
    provenance: 'measured_local',
    gate,
    testCommand: info.testCommand,
    testExitCode: testRes.exitCode,
    testDurationMs: testRes.durationMs,
    rawTestOutput: testRes.combined,
    compressedTestLog,
    lintCommand: info.lintCommand,
    lintExitCode: lintRes.exitCode,
    lintDurationMs: lintRes.durationMs,
    rawLintOutput: lintRes.combined,
  };
}
