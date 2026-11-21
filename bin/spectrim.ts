#!/usr/bin/env node
import fs from 'node:fs';
import { parseOpenSpecBundle, sliceSpecForTask } from '../src/engine/specSlicer';
import { compressGitDiff, compressTestLog, TestRunnerKind } from '../src/engine/outputCompressor';
import { detectRepoOnDisk, readOpenSpecBundleFromDisk } from '../src/runtime/repoFs';
import { runLocalPreReviewGate } from '../src/runtime/localGateRunner';
import { runRealAbWorktreeBenchmark } from '../src/runtime/abWorktreeRunner';
import { resolveConfinedPath } from '../src/runtime/pathGuard';

function printUsage() {
  console.log(`SpecTrim CLI — Token-Efficient SDD Pipeline

Usage:
  spectrim detect <repoPath>
  spectrim inspect <repoPath> <changeId>
  spectrim slice <repoPath> <changeId> [--task TSK-01] [--completed TSK-01,TSK-02]
  spectrim gate <repoPath> <changeId>
  spectrim compress --kind <test|diff> [--runner node_test|pytest|unittest|vitest|go_test] <filePath>
  spectrim bench <repoPath> <changeId> [--provider gemini|openai_compat] [--model gemini-4-hydrogen] [--reviews 3]
`);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === 'detect') {
    const repoPath = args[1] || 'benchmarks/orders-ts';
    const info = detectRepoOnDisk(repoPath);
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  if (cmd === 'inspect') {
    const repoPath = args[1] || 'benchmarks/orders-ts';
    const changeId = args[2] || 'add-rate-limit-and-audit';
    const bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
    const graph = parseOpenSpecBundle(bundle);
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  if (cmd === 'slice') {
    const repoPath = args[1] || 'benchmarks/orders-ts';
    const changeId = args[2] || 'add-rate-limit-and-audit';
    const taskId = getFlag(args, '--task') || 'TSK-01';
    const completedRaw = getFlag(args, '--completed') || '';
    const completed = completedRaw ? completedRaw.split(',').map((s) => s.trim()) : [];
    const bundle = readOpenSpecBundleFromDisk(repoPath, changeId);
    const slice = sliceSpecForTask(bundle, taskId, completed);
    console.log(JSON.stringify(slice, null, 2));
    return;
  }

  if (cmd === 'gate') {
    const repoPath = args[1] || 'benchmarks/orders-ts';
    const changeId = args[2] || 'add-rate-limit-and-audit';
    const report = await runLocalPreReviewGate(repoPath, changeId);
    console.log(JSON.stringify(report, null, 2));
    if (!report.gate.passed) process.exit(2);
    return;
  }

  if (cmd === 'compress') {
    const kind = getFlag(args, '--kind') || 'test';
    const runner = (getFlag(args, '--runner') || 'pytest') as TestRunnerKind;
    const fileArg = args[args.length - 1];
    const absFile = resolveConfinedPath(fileArg);
    const raw = fs.readFileSync(absFile, 'utf8');
    const res = kind === 'diff' ? compressGitDiff(raw) : compressTestLog(raw, runner);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'bench') {
    const repoPath = args[1] || 'benchmarks/orders-ts';
    const changeId = args[2] || 'add-idempotency-and-webhooks';
    const provider = getFlag(args, '--provider') as 'gemini' | 'openai_compat' | undefined;
    const model = getFlag(args, '--model');
    const reviews = Number(getFlag(args, '--reviews') || '3');

    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());

    const report = await runRealAbWorktreeBenchmark({
      repoPath,
      changeId,
      provider,
      model,
      maxReviewIters: reviews,
      signal: controller.signal,
      onProgress: (ev) => {
        console.error(`[${ev.phase}] ${ev.message}`);
      },
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
