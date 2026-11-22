import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AbRunReport,
  IsolationMode,
  LlmProviderId,
  PipelineSideSummary,
  RunManifest,
  SddStage,
  StageSideBreakdown,
  TelemetryEventRecord,
} from '../engine/provenance';
import {
  OpenSpecBundle,
  parseOpenSpecBundle,
  sliceSpecForTask,
  TaskNode,
} from '../engine/specSlicer';
import {
  applyHashlinePatch,
  HashlinePatchRequest,
  renderAstLodView,
} from '../engine/astLodHashline';
import {
  analyzeTestRunOutput,
  compressGitDiff,
  compressTestLog,
} from '../engine/outputCompressor';
import { runPreReviewGate } from '../engine/preReviewGate';
import { generateJuryDeliverables } from '../engine/juryDeliverables';
import { resolveConfinedPath, RUNS_ROOT, sanitizeIdSegment } from './pathGuard';
import {
  collectRepoFiles,
  SNAPSHOT_POLICY,
  detectRepoOnDisk,
  readOpenSpecBundleFromDisk,
  writeRepoFileConfined,
} from './repoFs';
import { prepareBenchmarkIsolation } from './benchmarkIsolation';
import { runSafeCommand, splitCommandArgs } from './execUtils';
import { callLlmWithUsage, getProviderStatusAsync } from './llmProvider';

export interface StartAbBenchmarkOptions {
  repoPath: string;
  changeId: string;
  provider?: LlmProviderId;
  model?: string;
  maxReviewIters?: number;
  signal?: AbortSignal;
  onProgress?: (event: BenchmarkProgressEvent) => void;
}

export interface BenchmarkProgressEvent {
  ts: string;
  runId: string;
  phase: 'setup' | 'baseline' | 'spectrim' | 'verify' | 'done' | 'error' | 'cancelled';
  message: string;
  step?: number;
  totalSteps?: number;
}

interface StageAccumulator {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  durationMs: number;
  retries: number;
  costUsd: number;
  hasKnownCost: boolean;
  cacheUsageMeasured: boolean;
}

function emptyAcc(): StageAccumulator {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    retries: 0,
    costUsd: 0,
    hasKnownCost: false,
    cacheUsageMeasured: false,
  };
}

const STAGE_LABELS: Record<SddStage, string> = {
  spec_prep: 'Спецификация (Propose / Sync)',
  apply: 'Реализация задач (Apply)',
  review: 'Ревью (Review Cycles)',
  verify: 'Верификация (Verify & Audit)',
};

function expandTestArgs(worktreeDir: string, args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg === 'tests/*.test.ts') {
      const testsDir = path.join(worktreeDir, 'tests');
      if (fs.existsSync(testsDir)) {
        const list = fs
          .readdirSync(testsDir)
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => path.join('tests', f));
        if (list.length > 0) {
          out.push(...list);
          continue;
        }
      }
    }
    out.push(arg);
  }
  return out;
}

async function execRepoChecks(
  worktreeDir: string,
  testCommand: string,
  lintCommand: string,
  signal?: AbortSignal
) {
  const tParts = splitCommandArgs(testCommand);
  const tRes = await runSafeCommand(tParts.bin, expandTestArgs(worktreeDir, tParts.args), worktreeDir, {
    timeoutMs: 45_000,
    signal,
  });
  const lParts = splitCommandArgs(lintCommand);
  const lRes = await runSafeCommand(lParts.bin, lParts.args, worktreeDir, {
    timeoutMs: 45_000,
    signal,
  });
  return { testRes: tRes, lintRes: lRes };
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function taskArtifactsSatisfied(repoDir: string, task: TaskNode): boolean {
  if (task.targetFiles.length === 0) return true;
  let allExist = true;
  let combined = '';
  for (const rel of task.targetFiles) {
    const abs = resolveConfinedPath(path.join(repoDir, rel), repoDir);
    if (!fs.existsSync(abs)) {
      allExist = false;
      continue;
    }
    combined += '\n' + fs.readFileSync(abs, 'utf8');
  }
  if (!allExist) return false;
  if (task.linkedReqs.length === 0) return true;
  return task.linkedReqs.every((req) => combined.includes(`@spec:${req}`) || combined.includes(req));
}

function markTaskDoneInFile(
  worktreeDir: string,
  changeId: string,
  taskId: string,
  done = true
): void {
  const tasksPath = path.join(worktreeDir, 'openspec', 'changes', changeId, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return;
  const content = fs.readFileSync(tasksPath, 'utf8');
  const mark = done ? 'x' : ' ';
  const updated = content.replace(
    new RegExp(`^(-\\s+\\[)[ xX](\\]\\s+\\[?${taskId}\\]?)`, 'm'),
    `$1${mark}$2`
  );
  fs.writeFileSync(tasksPath, updated, 'utf8');
}

function syncCompletedTasksInFile(
  repoDir: string,
  changeId: string,
  tasks: TaskNode[]
): string[] {
  const completed: string[] = [];
  for (const task of tasks) {
    const satisfied = task.completed || taskArtifactsSatisfied(repoDir, task);
    if (satisfied) {
      markTaskDoneInFile(repoDir, changeId, task.id, true);
      completed.push(task.id);
    }
  }
  return completed;
}

function normalizeNoIndexDiff(rawDiff: string, sideDirName: string): string {
  if (!rawDiff) return '';
  const escapedSide = sideDirName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return rawDiff
    .replace(
      new RegExp(
        `^diff --git a/(?:snapshot-base|${escapedSide})/(.+?) b/(?:snapshot-base|${escapedSide})/(.+)$`,
        'gm'
      ),
      'diff --git a/$1 b/$2'
    )
    .replace(
      new RegExp(`^diff --git a/(?:snapshot-base|${escapedSide})/([^\\s]+)\\s*$`, 'gm'),
      'diff --git a/$1 b/$1'
    )
    .replace(/^--- a\/snapshot-base\//gm, '--- a/')
    .replace(new RegExp(`^--- a/${escapedSide}/`, 'gm'), '--- a/')
    .replace(new RegExp(`^\\+\\+\\+ b/${escapedSide}/`, 'gm'), '+++ b/')
    .replace(/^\+\+\+ b\/snapshot-base\//gm, '+++ b/')
    .replace(/^--- \/dev\/null$/gm, '--- /dev/null')
    .replace(/^\+\+\+ \/dev\/null$/gm, '+++ /dev/null');
}

async function computeIsolatedDiffAndStatus(
  isolationMode: IsolationMode,
  runDir: string,
  repoDir: string,
  sideDirName: string,
  signal?: AbortSignal
): Promise<{ diff: string; changedFiles: string[] }> {
  if (isolationMode === 'git_worktree') {
    const staged = await runSafeCommand('git', ['add', '-N', '--', '.'], repoDir, { signal });
    if (staged.exitCode !== 0) throw new Error(`git add -N failed: ${staged.combined}`);
    const diffRes = await runSafeCommand('git', ['diff', '--relative', '--no-color', '--', '.'], repoDir, {
      signal,
    });
    const statusRes = await runSafeCommand('git', ['status', '--short', '--', '.'], repoDir, {
      signal,
    });
    if (diffRes.exitCode !== 0 || statusRes.exitCode !== 0) {
      throw new Error(`Cannot read worktree diff/status: ${diffRes.combined} ${statusRes.combined}`);
    }
    return {
      diff: diffRes.stdout,
      changedFiles: statusRes.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    };
  }

  const diffRes = await runSafeCommand(
    'git',
    ['diff', '--no-index', '--no-color', '--', 'snapshot-base', sideDirName],
    runDir,
    { signal }
  );
  if (diffRes.exitCode > 1) {
    throw new Error(`git diff --no-index failed (exit ${diffRes.exitCode}): ${diffRes.combined}`);
  }
  const statusRes = await runSafeCommand(
    'git',
    ['diff', '--no-index', '--name-status', '--', 'snapshot-base', sideDirName],
    runDir,
    { signal }
  );
  if (statusRes.exitCode > 1) throw new Error(`Cannot read snapshot status: ${statusRes.combined}`);
  const changedFiles = statusRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/);
      if (parts.length >= 2) {
        const code = parts[0];
        const rel = parts[parts.length - 1]
          .replace(/^snapshot-base\//, '')
          .replace(new RegExp(`^${sideDirName}/`), '');
        return `${code} ${rel}`;
      }
      return line;
    });

  return {
    diff: normalizeNoIndexDiff(diffRes.stdout, sideDirName),
    changedFiles,
  };
}

interface AgentPatchPayload {
  hashline_patches?: Array<HashlinePatchRequest & { path: string }>;
  files?: Array<{ path: string; content: string }>;
  exported_symbol?: string;
}

function applyAgentEdits(
  repoDir: string,
  parsed: AgentPatchPayload | null,
  allowedPaths?: ReadonlySet<string>
): { appliedCount: number; patchErrors: string[] } {
  const patchErrors: string[] = [];
  let appliedCount = 0;

  if (!parsed) {
    return { appliedCount: 0, patchErrors: ['Invalid JSON response from agent'] };
  }

  if (Array.isArray(parsed.hashline_patches)) {
    for (const p of parsed.hashline_patches) {
      if (typeof p?.path !== 'string') continue;
      if (allowedPaths && !allowedPaths.has(p.path)) {
        patchErrors.push(`Unexpected file: ${p.path}`);
        continue;
      }
      const absF = resolveConfinedPath(path.join(repoDir, p.path), repoDir);
      if (!fs.existsSync(absF)) {
        patchErrors.push(`Target file ${p.path} does not exist for hashline_patch`);
        continue;
      }
      const orig = fs.readFileSync(absF, 'utf8');
      const patchRes = applyHashlinePatch(orig, p);
      if (patchRes.ok) {
        writeRepoFileConfined(repoDir, p.path, patchRes.updatedContent);
        appliedCount++;
      } else {
        patchErrors.push(`${p.path}: ${patchRes.error}`);
      }
    }
  }

  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files) {
      if (typeof f?.path === 'string' && typeof f.content === 'string') {
        if (allowedPaths && !allowedPaths.has(f.path)) {
          patchErrors.push(`Unexpected file: ${f.path}`);
          continue;
        }
        if (fs.existsSync(resolveConfinedPath(path.join(repoDir, f.path), repoDir))) {
          patchErrors.push(`Use a hashline patch for existing file ${f.path}`);
          continue;
        }
        writeRepoFileConfined(repoDir, f.path, f.content);
        appliedCount++;
      }
    }
  }

  return { appliedCount, patchErrors };
}

export function listSavedRuns(): Array<{
  runId: string;
  createdAt: string;
  repoName: string;
  changeId: string;
  model: string;
  provider: string;
  status: string;
  provenance: string;
  totalSavingsPct: number | null;
}> {
  if (!fs.existsSync(RUNS_ROOT)) return [];
  const entries = fs.readdirSync(RUNS_ROOT, { withFileTypes: true });
  const runs: Array<{
    runId: string;
    createdAt: string;
    repoName: string;
    changeId: string;
    model: string;
    provider: string;
    status: string;
    provenance: string;
    totalSavingsPct: number | null;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = path.join(RUNS_ROOT, entry.name, 'summary.json');
    if (fs.existsSync(summaryPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as AbRunReport;
        runs.push({
          runId: parsed.manifest.runId,
          createdAt: parsed.manifest.createdAt,
          repoName: parsed.manifest.repoName,
          changeId: parsed.manifest.changeId,
          model: parsed.manifest.model,
          provider: parsed.manifest.provider,
          status: parsed.manifest.status,
          provenance: parsed.provenance,
          totalSavingsPct: parsed.savings.totalTokensPct,
        });
      } catch {
        // ignore corrupted run directory
      }
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loadSavedRun(runId: string): AbRunReport {
  const safeId = sanitizeIdSegment(runId, 'runId');
  const summaryPath = resolveConfinedPath(
    path.join(RUNS_ROOT, safeId, 'summary.json'),
    RUNS_ROOT
  );
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Saved benchmark run not found: ${safeId}`);
  }
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as AbRunReport;
}

export async function runRealAbWorktreeBenchmark(
  opts: StartAbBenchmarkOptions
): Promise<AbRunReport> {
  const providerStatus = await getProviderStatusAsync();
  const selectedProvider =
    opts.provider ??
    (providerStatus.defaultProvider === 'none' ? null : providerStatus.defaultProvider);

  if (!selectedProvider) {
    throw new Error(
      'Провайдер LLM не настроен: задайте GEMINI_API_KEY в Settings > Secrets/.env или запустите локальную Ollama (ollama serve + ollama pull qwen2.5-coder:7b) без API-ключа.'
    );
  }

  if (selectedProvider === 'gemini' && !providerStatus.geminiConfigured) {
    throw new Error(
      'Выбран провайдер Gemini, но GEMINI_API_KEY не задан в .env или Settings > Secrets.'
    );
  }
  if (selectedProvider === 'ollama') {
    if (!providerStatus.ollamaStatus.enabled) {
      throw new Error('Провайдер Ollama отключён через OLLAMA_ENABLED=false.');
    }
    if (!providerStatus.ollamaStatus.reachable) {
      throw new Error(
        providerStatus.ollamaStatus.error ||
          `Локальный сервер Ollama недоступен (${providerStatus.ollamaStatus.baseUrl}). Запустите: ollama serve`
      );
    }
    if (providerStatus.ollamaStatus.installedModels.length === 0 && !opts.model?.trim()) {
      throw new Error(
        'В Ollama не установлено ни одной модели. Скачайте модель: ollama pull qwen2.5-coder:7b'
      );
    }
  }
  if (selectedProvider === 'openai_compat' && !providerStatus.openAiCompatConfigured) {
    throw new Error(
      'Выбран провайдер openai_compat, но OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY не настроены.'
    );
  }

  const defaultModel =
    selectedProvider === 'gemini'
      ? 'gemini-4-hydrogen'
      : selectedProvider === 'ollama'
      ? providerStatus.ollamaStatus.configuredModel ||
        providerStatus.ollamaStatus.installedModels[0] ||
        'qwen2.5-coder:7b'
      : process.env.OPENAI_COMPAT_MODEL?.trim() || 'custom-model';
  const model = opts.model?.trim() || defaultModel;
  const maxReviewIters = Math.max(1, Math.min(5, opts.maxReviewIters ?? 3));

  const absRepo = resolveConfinedPath(opts.repoPath);
  const repoInfo = detectRepoOnDisk(opts.repoPath);
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const runDir = path.join(RUNS_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestPath = path.join(runDir, 'run_manifest.json');
  const isolation = await prepareBenchmarkIsolation(absRepo, runDir, opts.signal).catch(error => {
    fs.writeFileSync(manifestPath, JSON.stringify({
      runId, createdAt: new Date().toISOString(), repoPath: repoInfo.repoPath,
      repoName: repoInfo.repoName, changeId: opts.changeId,
      provider: selectedProvider, model, baseCommit: null, sameModelEnforced: false,
      status: opts.signal?.aborted ? 'cancelled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2));
    throw error;
  });
  const { mode: isolationMode, baselineDir: baselineRepoDir, optimizedDir: optimizedRepoDir,
    baseCommit, snapshotHash, git: gitCtx } = isolation;

  const emit = (
    phase: BenchmarkProgressEvent['phase'],
    message: string,
    step?: number,
    totalSteps?: number
  ) => {
    opts.onProgress?.({
      ts: new Date().toISOString(),
      runId,
      phase,
      message,
      step,
      totalSteps,
    });
  };

  const manifest: RunManifest = {
    runId,
    createdAt: new Date().toISOString(),
    repoPath: repoInfo.repoPath,
    repoName: repoInfo.repoName,
    changeId: opts.changeId,
    baseCommit,
    isolationMode,
    snapshotHash,
    snapshotPolicy: snapshotHash ? SNAPSHOT_POLICY : undefined,
    isolationNote: isolation.reason,
    gitRoot: gitCtx.gitRoot,
    repoSubpath: gitCtx.repoSubpath,
    provider: selectedProvider,
    model,
    sameModelEnforced: false,
    detectedLanguage: repoInfo.language,
    testCommand: repoInfo.testCommand,
    lintCommand: repoInfo.lintCommand,
    baselineWorktree: path.relative(process.cwd(), baselineRepoDir),
    optimizedWorktree: path.relative(process.cwd(), optimizedRepoDir),
    status: 'running',
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const telemetry: TelemetryEventRecord[] = [];
  const metricsPath = path.join(runDir, 'metrics.jsonl');
  const attemptsPath = path.join(runDir, 'provider-attempts.jsonl');
  let usageComplete = true;
  const appendJson = (file: string, value: object) =>
    fs.appendFileSync(file, JSON.stringify(value) + '\n');
  const finalChecksPath = path.join(runDir, 'checks.jsonl');
  const runChecks = async (side: 'baseline' | 'spectrim', step: string, repoDir: string) => {
    const result = await execRepoChecks(repoDir, repoInfo.testCommand, repoInfo.lintCommand, opts.signal);
    appendJson(finalChecksPath, { side, step, ...result });
    return result;
  };

  const acceptancePath = fileURLToPath(new URL('./acceptance/orders-idempotency.test.mts', import.meta.url));
  const runAcceptance = async (side: 'baseline' | 'spectrim', step: string, repoDir: string) => {
    if (opts.changeId !== 'add-idempotency-and-webhooks' || repoInfo.language !== 'typescript') {
      return null;
    }
    const args = ['--import', 'tsx', '--test', '--test-reporter=tap', acceptancePath];
    const result = await runSafeCommand(process.execPath, args, repoDir, { signal: opts.signal });
    appendJson(finalChecksPath, { side, step, command: [process.execPath, ...args], acceptance: result });
    return result;
  };
  const lintFailures = (check: Awaited<ReturnType<typeof execRepoChecks>>['lintRes']) =>
    check.exitCode === 0 ? [] : [check.combined || `Typecheck/lint failed (exit ${check.exitCode})`];
  const provenance = selectedProvider === 'ollama' ? 'measured_local' : 'measured';


  const recordUsage = (
    run: 'baseline' | 'spectrim',
    stage: SddStage,
    taskId: string,
    acc: StageAccumulator,
    resp: Awaited<ReturnType<typeof callLlmWithUsage>>,
    retries: number,
    reviewIter: number
  ) => {
    acc.promptTokens += resp.usage.promptTokens;
    acc.completionTokens += resp.usage.completionTokens;
    acc.cachedInputTokens += resp.usage.cachedInputTokens;
    acc.uncachedInputTokens += resp.usage.uncachedInputTokens;
    acc.thoughtsTokens += resp.usage.thoughtsTokens;
    acc.totalTokens += resp.usage.totalTokens;
    acc.durationMs += resp.durationMs;
    acc.retries += retries;
    if (resp.usage.costUsd !== null) {
      acc.hasKnownCost = true;
      acc.costUsd += resp.usage.costUsd;
    }
    if (resp.usage.cacheUsageMeasured) {
      acc.cacheUsageMeasured = true;
    }

    const row: TelemetryEventRecord = {
      ts: new Date().toISOString(),
      run,
      provider: selectedProvider,
      model,
      resolved_model: resp.model,
      stage,
      task_id: taskId,
      prompt_tokens: resp.usage.promptTokens,
      completion_tokens: resp.usage.completionTokens,
      cached_input_tokens: resp.usage.cachedInputTokens,
      uncached_input_tokens: resp.usage.uncachedInputTokens,
      thoughts_tokens: resp.usage.thoughtsTokens,
      total_tokens: resp.usage.totalTokens,
      tool_calls: 0,
      retries,
      review_iteration: reviewIter,
      duration_ms: resp.durationMs,
      cost_usd: resp.usage.costUsd,
      cache_usage_measured: resp.usage.cacheUsageMeasured,
      provenance,
      provider_usage: resp.rawUsage,
    };
    telemetry.push(row);
    appendJson(metricsPath, row);
  };
  const measure = async (
    side: 'baseline' | 'spectrim', stage: SddStage, taskId: string, acc: StageAccumulator,
    request: Parameters<typeof callLlmWithUsage>[0], retries = 0, reviewIter = 0
  ) => {
    const attemptLog = (error: unknown, attempt: number) => {
      usageComplete = false;
      appendJson(attemptsPath, { side, stage, taskId, attempt, status: 'failed', usage: null,
        error: error instanceof Error ? error.name : 'ProviderError' });
    };
    let failures = 0;
    try {
      const response = await callLlmWithUsage({ ...request, onRetry: (error, attempt) => {
        failures++;
        attemptLog(error, attempt);
      } });
      appendJson(attemptsPath, { side, stage, taskId, attempt: failures + 1, status: 'ok' });
      recordUsage(side, stage, taskId, acc, response, retries + failures, reviewIter);
      return response;
    } catch (error) {
      attemptLog(error, failures + 1);
      throw error;
    }
  };

  try {
    const bundle = readOpenSpecBundleFromDisk(baselineRepoDir, opts.changeId);
    const graph = parseOpenSpecBundle(bundle);
    const benchmarkTargets = opts.changeId === 'add-idempotency-and-webhooks' && repoInfo.language === 'typescript'
      ? new Set(graph.tasks.flatMap(task => task.targetFiles))
      : undefined;
    const applyBaselineEdits = (edits: unknown) => {
      if (!Array.isArray(edits)) return false;
      let applied = false;
      for (const edit of edits) {
        if (typeof edit?.path !== 'string' || typeof edit.content !== 'string' ||
          (benchmarkTargets && !benchmarkTargets.has(edit.path))) continue;
        writeRepoFileConfined(baselineRepoDir, edit.path, edit.content);
        applied = true;
      }
      return applied;
    };
    if (graph.tasks.length === 0) {
      throw new Error(`В change ${opts.changeId} не найдены задачи в tasks.md`);
    }
    emit('setup', isolationMode === 'git_worktree'
      ? `Два Git worktree от ${baseCommit} (${gitCtx.repoSubpath || '.'}).`
      : `Две проверенные копии снимка SHA-256 ${snapshotHash}. ${isolation.reason}`);

    const totalSteps = graph.tasks.length * 2 + 6;
    let currentStep = 0;

    // =========================================================================
    // RUN A: BASELINE (Monolithic single-session, full spec, raw logs, full diff)
    // =========================================================================
    const baseAcc: Record<SddStage, StageAccumulator> = {
      spec_prep: emptyAcc(),
      apply: emptyAcc(),
      review: emptyAcc(),
      verify: emptyAcc(),
    };

    const fullSpecDump = [
      `# proposal.md\n${bundle.proposalMd}`,
      ...Object.entries(bundle.specsMd).map(([k, v]) => `# specs/${k}/spec.md\n${v}`),
      `# design.md\n${bundle.designMd}`,
      `# tasks.md\n${bundle.tasksMd}`,
    ].join('\n\n');

    const baseFilesSnapshot = collectRepoFiles(baselineRepoDir)
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');

    emit(
      'baseline',
      '[Baseline] spec_prep: чтение полной спеки и структуры репозитория...',
      ++currentStep,
      totalSteps
    );
    const basePrepResp = await measure('baseline', 'spec_prep', 'SPEC-ALL', baseAcc.spec_prep, {
      provider: selectedProvider,
      model,
      systemInstruction:
        'You are a software engineer implementing an OpenSpec change. Respond strictly with valid JSON.',
      prompt: `Review the full OpenSpec artifacts and existing repository files, and output JSON {"plan": ["..."], "risks": ["..."]}.\n\n${fullSpecDump}\n\n${baseFilesSnapshot}`,
      signal: opts.signal,
    });

    let accumulatedHistory = `Plan: ${basePrepResp.text}\n`;
    const pendingTasks = graph.tasks.filter((t) => !t.completed);
    const tasksToRun = pendingTasks.length > 0 ? pendingTasks : graph.tasks.slice(0, 3);

    for (const task of tasksToRun) {
      emit('baseline', `[Baseline] apply ${task.id}: монолитная сессия...`, ++currentStep, totalSteps);
      const currentFiles = collectRepoFiles(baselineRepoDir)
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');

      const applyPrompt = `Execute task ${task.id}: ${task.title}
Return JSON: {"edits": [{"path": "relative/path.ts", "content": "full updated file content"}]}.
Include @spec:REQ-XX markers in code and tests.

[FULL OPENSPEC]
${fullSpecDump}

[FULL REPOSITORY FILES]
${currentFiles}

[SESSION HISTORY SO FAR]
${accumulatedHistory}`;

      const resp = await measure('baseline', 'apply', task.id, baseAcc.apply, {
        provider: selectedProvider,
        model,
        systemInstruction:
          'You are a coding agent working in a continuous single session. Always return full file contents in JSON {"edits":[{"path":"...","content":"..."}]}.',
        prompt: applyPrompt,
        signal: opts.signal,
      });

      const parsed = parseJsonSafe<{ edits?: Array<{ path: string; content: string }> }>(resp.text);
      applyBaselineEdits(parsed?.edits);

      const checks = await runChecks('baseline', task.id, baselineRepoDir);
      if (taskArtifactsSatisfied(baselineRepoDir, task)) {
        markTaskDoneInFile(baselineRepoDir, bundle.changeId, task.id, true);
      }

      const rawToolOutput = `TEST EXIT ${checks.testRes.exitCode}:\n${checks.testRes.combined}\nLINT EXIT ${checks.lintRes.exitCode}:\n${checks.lintRes.combined}`;
      accumulatedHistory += `\n--- Step ${task.id} ---\nAssistant edits: ${resp.text.slice(0, 1800)}\nTool output:\n${rawToolOutput}\n`;
    }

    // Baseline review iterations (full diff + raw logs)
    let baselineReviewIters = 0;
    for (let iter = 1; iter <= maxReviewIters; iter++) {
      baselineReviewIters = iter;
      emit('baseline', `[Baseline] review итерация ${iter}/${maxReviewIters}...`, ++currentStep, totalSteps);
      const { diff: rawDiffText } = await computeIsolatedDiffAndStatus(
        isolationMode,
        runDir,
        baselineRepoDir,
        'worktree-baseline',
        opts.signal
      );
      const untrackedFiles = collectRepoFiles(baselineRepoDir)
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');
      const checks = await runChecks('baseline', `review-${iter}`, baselineRepoDir);
      const acceptance = await runAcceptance('baseline', `review-${iter}`, baselineRepoDir);
      const testAnalysis = analyzeTestRunOutput(checks.testRes.combined, checks.testRes.exitCode);

      const revResp = await measure('baseline', 'review', `REV-${iter}`, baseAcc.review, {
        provider: selectedProvider,
        model,
        systemInstruction:
          'You are a strict code reviewer. Return JSON {"approved": boolean, "issues": ["..."], "edits": [{"path":"...","content":"..."}]}.',
        prompt: `Review iteration ${iter}. Check all requirements, tests, and typecheck.\n\n[FULL SPEC]\n${fullSpecDump}\n\n[GIT DIFF]\n${rawDiffText}\n\n[FULL FILES]\n${untrackedFiles}\n\n[RAW TEST/LINT]\n${checks.testRes.combined}\n${checks.lintRes.combined}\n[INDEPENDENT ACCEPTANCE]\n${acceptance?.combined ?? 'unavailable'}`,
        signal: opts.signal,
      }, 0, iter);

      const parsedRev = parseJsonSafe<{
        approved?: boolean;
        edits?: Array<{ path: string; content: string }>;
      }>(revResp.text);

      const editsApplied = applyBaselineEdits(parsedRev?.edits);

      if (parsedRev?.approved && !editsApplied && testAnalysis.passed && checks.lintRes.exitCode === 0 && (acceptance?.exitCode ?? 0) === 0) {
        break;
      }
    }

    // Baseline final verification
    const baseFinalChecks = await runChecks('baseline', 'verify', baselineRepoDir);
    const baseAcceptance = await runAcceptance('baseline', 'verify', baselineRepoDir);
    const baseFinalTestAnalysis = analyzeTestRunOutput(
      baseFinalChecks.testRes.combined,
      baseFinalChecks.testRes.exitCode
    );
    await measure('baseline', 'verify', 'VERIFY-ALL', baseAcc.verify, {
      provider: selectedProvider,
      model,
      systemInstruction:
        'Verify OpenSpec compliance and return JSON {"verified": boolean, "summary": "..."}.',
      prompt: `Verify all requirements and tests.\n${fullSpecDump}\nTest exit: ${baseFinalChecks.testRes.exitCode}\n${baseFinalChecks.testRes.combined}`,
      signal: opts.signal,
    });

    // =========================================================================
    // RUN B: SPECTRIM OPTIMIZED (Task-sliced micro-sessions, AST-LOD, Hashline, Compressor, Gate, Delta)
    // =========================================================================
    const optAcc: Record<SddStage, StageAccumulator> = {
      spec_prep: emptyAcc(),
      apply: emptyAcc(),
      review: emptyAcc(),
      verify: emptyAcc(),
    };

    emit('spectrim', '[SpecTrim] spec_prep: локальный граф REQ → DES → TSK, 0 LLM-запросов.',
      ++currentStep, totalSteps);

    const completedContracts: Array<{ taskId: string; file: string; symbol: string; reqs: string[] }> = [];
    const completedIds: string[] = graph.tasks.filter((t) => t.completed).map((t) => t.id);

    let previousCheckFailures = '';
    const staticSystemPrompt =
      'You are a SpecTrim micro-session coding agent. For existing files shown in LOD0 (L{n}#{hash}: ...), ALWAYS output compact "hashline_patches" ranges instead of rewriting full files. Only use "files" when creating a brand-new file not yet on disk. Return strict JSON {"hashline_patches":[{"path":"...","startLine":1,"startHash":"abc","endLine":1,"endHash":"abc","replacement":"..."}], "files":[{"path":"...","content":"..."}], "exported_symbol":"..."}.';

    for (const task of tasksToRun) {
      emit(
        'spectrim',
        `[SpecTrim] apply ${task.id}: изолированная микро-сессия + AST-LOD...`,
        ++currentStep,
        totalSteps
      );
      const currentBundle = readOpenSpecBundleFromDisk(optimizedRepoDir, bundle.changeId);
      const slice = sliceSpecForTask(currentBundle, task.id, completedIds, completedContracts);

      const wtFiles = collectRepoFiles(optimizedRepoDir);
      const wtFileMap = new Map(wtFiles.map((f) => [f.path, f]));
      const targetSet = new Set(task.targetFiles);
      const contractFiles = new Set(completedContracts.map((c) => c.file));

      const targetBlocks: string[] = [];
      const neighborLod1Blocks: string[] = [];
      const repoMapPaths: string[] = [];

      for (const targetRel of task.targetFiles) {
        const existing = wtFileMap.get(targetRel);
        if (existing) {
          const view = renderAstLodView(
            existing.path,
            existing.content,
            repoInfo.language,
            'LOD0'
          );
          targetBlocks.push(
            `### EXISTING TARGET FILE (edit via hashline_patches ONLY): ${existing.path}\n${view.rendered}`
          );
        } else {
          targetBlocks.push(
            `### NEW TARGET FILE (create via files): ${targetRel}`
          );
        }
      }

      for (const f of wtFiles) {
        if (targetSet.has(f.path)) continue;
        repoMapPaths.push(f.path);
        const isDirectDependency =
          !f.isTest || contractFiles.has(f.path);
        if (isDirectDependency) {
          const view = renderAstLodView(f.path, f.content, repoInfo.language, 'LOD1');
          neighborLod1Blocks.push(view.rendered);
        }
      }

      const lod2Section =
        repoMapPaths.length > 0
          ? `# AST-LOD2 Repository Map\n${repoMapPaths.map((p) => `- ${p}`).join('\n')}`
          : '';

      const microPrompt = [
        slice.compiledPromptBundle,
        `[TARGET_FILES_LOD0]\n${targetBlocks.join('\n\n')}`,
        neighborLod1Blocks.length > 0 ? `[NEIGHBOR_INTERFACES_LOD1]\n${neighborLod1Blocks.join('\n\n')}` : '',
        lod2Section,
        previousCheckFailures && `[PREVIOUS CHECK FAILURES]\n${previousCheckFailures}`,
      ]
        .filter(Boolean)
        .join('\n\n');

      const resp = await measure('spectrim', 'apply', task.id, optAcc.apply, {
        provider: selectedProvider,
        model,
        systemInstruction: staticSystemPrompt,
        prompt: microPrompt,
        signal: opts.signal,
      });

      const parsed = parseJsonSafe<AgentPatchPayload>(resp.text);
      const editOutcome = applyAgentEdits(optimizedRepoDir, parsed, benchmarkTargets);

      if (!parsed || editOutcome.patchErrors.length > 0) {
        // Single targeted micro-retry refreshing only the failed file's LOD0
        const refreshedFiles = collectRepoFiles(optimizedRepoDir);
        const refreshedTargets = task.targetFiles
          .map((tPath) => refreshedFiles.find((rf) => rf.path === tPath))
          .filter((rf): rf is NonNullable<typeof rf> => Boolean(rf))
          .map((rf) => `### REFRESHED LOD0 ${rf.path}\n${renderAstLodView(rf.path, rf.content, repoInfo.language, 'LOD0').rendered}`);

        const retryPrompt = `${slice.compiledPromptBundle}\n\n[PATCH_REPAIR]\nErrors: ${editOutcome.patchErrors.join('; ')}\n${refreshedTargets.join('\n\n')}`;
        const retryResp = await measure('spectrim', 'apply', `${task.id}-RETRY`, optAcc.apply, {
          provider: selectedProvider,
          model,
          systemInstruction: staticSystemPrompt,
          prompt: retryPrompt,
          signal: opts.signal,
        }, 1);
        const retryParsed = parseJsonSafe<AgentPatchPayload>(retryResp.text);
        applyAgentEdits(optimizedRepoDir, retryParsed, benchmarkTargets);
        if (retryParsed?.exported_symbol) {
          completedContracts.push({
            taskId: task.id,
            file: task.targetFiles[0] || 'src/',
            symbol: retryParsed.exported_symbol,
            reqs: task.linkedReqs,
          });
        }
      } else if (parsed?.exported_symbol) {
        completedContracts.push({
          taskId: task.id,
          file: task.targetFiles[0] || 'src/',
          symbol: parsed.exported_symbol,
          reqs: task.linkedReqs,
        });
      }

      const checks = await runChecks('spectrim', task.id, optimizedRepoDir);
      previousCheckFailures = [
        checks.testRes.exitCode === 0 ? '' : compressTestLog(checks.testRes.combined, repoInfo.testRunnerKind,
          { exitCode: checks.testRes.exitCode }).compressed,
        checks.lintRes.exitCode === 0 ? '' : lintFailures(checks.lintRes).join('\n').slice(0, 1600),
      ].filter(Boolean).join('\n');
      if (taskArtifactsSatisfied(optimizedRepoDir, task)) {
        markTaskDoneInFile(optimizedRepoDir, bundle.changeId, task.id, true);
        if (!completedIds.includes(task.id)) completedIds.push(task.id);
      }

      writeRepoFileConfined(
        optimizedRepoDir,
        `openspec/changes/${bundle.changeId}/state_capsule.json`,
        JSON.stringify(slice.stateCapsule, null, 2)
      );

    }

    // Zero-Token Pre-Review Gate + up to 2 Gate-guided repair micro-sessions
    const runGateCheck = async () => {
      const gateChecks = await runChecks('spectrim', 'gate', optimizedRepoDir);
      const testAnalysis = analyzeTestRunOutput(gateChecks.testRes.combined, gateChecks.testRes.exitCode);
      const acceptance = await runAcceptance('spectrim', 'gate', optimizedRepoDir);
      const curBundle = readOpenSpecBundleFromDisk(optimizedRepoDir, bundle.changeId);
      const curGraph = parseOpenSpecBundle(curBundle);
      const synced = syncCompletedTasksInFile(optimizedRepoDir, bundle.changeId, curGraph.tasks);
      for (const tid of synced) {
        if (!completedIds.includes(tid)) completedIds.push(tid);
      }
      const updatedBundle = readOpenSpecBundleFromDisk(optimizedRepoDir, bundle.changeId);
      const optFiles = collectRepoFiles(optimizedRepoDir);
      const gate = runPreReviewGate({
        bundle: updatedBundle,
        files: optFiles,
        testsPassing: testAnalysis.passed && (acceptance?.exitCode ?? 0) === 0,
        failingTestSnippet: acceptance && acceptance.exitCode !== 0
          ? compressTestLog(acceptance.combined, 'node_test', { exitCode: acceptance.exitCode }).compressed
          : testAnalysis.passed
          ? undefined
          : compressTestLog(gateChecks.testRes.combined, repoInfo.testRunnerKind, {
              exitCode: gateChecks.testRes.exitCode,
            }).compressed,
        lintErrors: lintFailures(gateChecks.lintRes),
        verifySubstance: true,
      });
      return { gate, gateChecks, optFiles };
    };

    emit('spectrim', '[SpecTrim] Zero-Token Pre-Review Gate (0 LLM токенов)...', ++currentStep, totalSteps);
    let gateState = await runGateCheck();

    for (let fixAttempt = 1; !gateState.gate.passed && fixAttempt <= 2; fixAttempt++) {
      emit(
        'spectrim',
        `[SpecTrim] Gate Repair #${fixAttempt}: исправление дефектов до LLM-ревью...`,
        currentStep,
        totalSteps
      );
      const existingFiles = new Map(gateState.optFiles.map(file => [file.path, file]));
      const repairPaths = new Set(graph.tasks.flatMap(task => task.targetFiles));
      for (const file of gateState.optFiles) {
        if (gateState.gateChecks.lintRes.combined.includes(file.path) ||
            gateState.gateChecks.testRes.combined.includes(file.path)) {
          repairPaths.add(file.path);
        }
      }
      const fixFilesLod0 = [...repairPaths].map(file => {
        const existing = existingFiles.get(file);
        return existing
          ? `### LOD0 ${file}\n${renderAstLodView(file, existing.content, repoInfo.language, 'LOD0').rendered}`
          : `### NEW TARGET FILE (create via files): ${file}`;
      });

      const fixPrompt = `${gateState.gate.conciseReport}\n\n[SPECS_SUMMARY]\n${Object.entries(bundle.specsMd)
        .map(([k, v]) => `## ${k}\n${v}`)
        .join('\n\n')}\n\n[FILES_LOD0]\n${fixFilesLod0.join('\n\n')}`;

      const fixResp = await measure('spectrim', 'apply', `GATE-FIX-${fixAttempt}`, optAcc.apply, {
        provider: selectedProvider,
        model,
        systemInstruction: staticSystemPrompt,
        prompt: fixPrompt,
        signal: opts.signal,
      }, Number(fixAttempt > 1));
      const parsedFix = parseJsonSafe<AgentPatchPayload>(fixResp.text);
      applyAgentEdits(optimizedRepoDir, parsedFix, benchmarkTargets);
      gateState = await runGateCheck();
    }

    let preGate = gateState.gate;

    let optimizedReviewIters = 0;
    if (preGate.passed) {
      optimizedReviewIters = 1;
      // Single Incremental Delta Review
      emit('spectrim', '[SpecTrim] Delta Review (1 проход по сжатому diff)...', ++currentStep, totalSteps);
      const { diff: optRawDiffText } = await computeIsolatedDiffAndStatus(
        isolationMode,
        runDir,
        optimizedRepoDir,
        'worktree-optimized',
        opts.signal
      );
      const compressedDiff = compressGitDiff(optRawDiffText);

      const deltaRevResp = await measure('spectrim', 'review', 'REV-DELTA-1', optAcc.review, {
        provider: selectedProvider,
        model,
        systemInstruction:
          'You are a delta code reviewer. Pre-Review Gate already verified deterministic checks. Only propose patches if a real behavioral or @spec bug exists in the delta. Return JSON {"approved": boolean, "notes": ["..."], "hashline_patches": [], "files": []}.',
        prompt: `Gate report:\n${preGate.conciseReport}\n\n[COMPRESSED DELTA DIFF]\n${compressedDiff.compressed}`,
        signal: opts.signal,
      }, 0, 1);
      const parsedDelta = parseJsonSafe<AgentPatchPayload & { approved?: boolean }>(deltaRevResp.text);
      if (parsedDelta && (parsedDelta.hashline_patches?.length || parsedDelta.files?.length)) {
        applyAgentEdits(optimizedRepoDir, parsedDelta, benchmarkTargets);
        gateState = await runGateCheck();
        preGate = gateState.gate;
      }

    }

    // Final verify (deterministic matrix + 1 tiny semantic confirmation)
    const optFinalChecks = await runChecks('spectrim', 'verify', optimizedRepoDir);
    const optAcceptance = await runAcceptance('spectrim', 'verify', optimizedRepoDir);
    const optFinalTestAnalysis = analyzeTestRunOutput(
      optFinalChecks.testRes.combined,
      optFinalChecks.testRes.exitCode
    );
    await measure('spectrim', 'verify', 'VERIFY-GATE', optAcc.verify, {
      provider: selectedProvider,
      model,
      systemInstruction: 'Return JSON {"verified": boolean}.',
      prompt: `Gate passed: ${preGate.passed}. Test exit: ${optFinalChecks.testRes.exitCode}. Tests green: ${optFinalTestAnalysis.passed}. Lint exit: ${optFinalChecks.lintRes.exitCode}.`,
      signal: opts.signal,
    });

    // Build Final Summaries & Diffs
    emit('verify', 'Сбор acceptance criteria, diff и сохранение артефактов...', ++currentStep, totalSteps);
    const baseArtifacts = await computeIsolatedDiffAndStatus(
      isolationMode,
      runDir,
      baselineRepoDir,
      'worktree-baseline',
      opts.signal
    );
    const optArtifacts = await computeIsolatedDiffAndStatus(
      isolationMode,
      runDir,
      optimizedRepoDir,
      'worktree-optimized',
      opts.signal
    );

    const buildSummary = (
      side: 'baseline' | 'spectrim',
      repoDir: string,
      accMap: Record<SddStage, StageAccumulator>,
      reviewIters: number,
      checks: Awaited<ReturnType<typeof execRepoChecks>>,
      testAnalysis: ReturnType<typeof analyzeTestRunOutput>,
      acceptance: Awaited<ReturnType<typeof runAcceptance>>,
      diffOut: string,
      changedFiles: string[]
    ): PipelineSideSummary => {
      const stages: StageSideBreakdown[] = (Object.keys(accMap) as SddStage[]).map((stage) => {
        const a = accMap[stage];
        return {
          stage,
          stageLabel: STAGE_LABELS[stage],
          promptTokens: a.promptTokens,
          completionTokens: a.completionTokens,
          cachedInputTokens: a.cachedInputTokens,
          uncachedInputTokens: a.uncachedInputTokens,
          thoughtsTokens: a.thoughtsTokens,
          totalTokens: a.totalTokens,
          durationMs: a.durationMs,
          toolCalls: 0,
          retries: a.retries,
          provenance: side === 'spectrim' && stage === 'spec_prep' ? 'measured_local' : provenance,
        };
      });

      const finalBundle = readOpenSpecBundleFromDisk(repoDir, bundle.changeId);
      const finalGraph = parseOpenSpecBundle(finalBundle);
      const finalFiles = collectRepoFiles(repoDir);
      const gateEval = runPreReviewGate({
        bundle: finalBundle,
        files: finalFiles,
        testsPassing: testAnalysis.passed,
        lintErrors:
          checks.lintRes.exitCode === 0
            ? []
            : [checks.lintRes.combined.trim().slice(0, 500) || `Lint failed (exit ${checks.lintRes.exitCode})`],
        verifySubstance: true,
      });

      const stripTaskStatus = (text: string) => text.replace(/(^\s*[-*]\s+)\[[ xX]\]/gm, '$1[ ]');
      const originalSpec = Object.entries(bundle.specsMd).sort();
      const specUnchanged = finalBundle.proposalMd === bundle.proposalMd &&
        finalBundle.designMd === bundle.designMd &&
        JSON.stringify(Object.entries(finalBundle.specsMd).sort()) === JSON.stringify(originalSpec) &&
        stripTaskStatus(finalBundle.tasksMd) === stripTaskStatus(bundle.tasksMd);
      const allReqIds = graph.requirements.map((r) => r.id);
      const uncoveredSet = new Set([
        ...gateEval.uncoveredReqsInCode,
        ...gateEval.uncoveredReqsInTests,
      ]);
      const coveredReqs = allReqIds.filter((id) => !uncoveredSet.has(id));
      const reqCoveragePct =
        allReqIds.length > 0
          ? Number(((coveredReqs.length / allReqIds.length) * 100).toFixed(1))
          : 0;

      const sumAcc = (fn: (a: StageAccumulator) => number) =>
        Object.values(accMap).reduce((s, a) => s + fn(a), 0);

      const hasKnownCost = Object.values(accMap).some((a) => a.hasKnownCost);
      const cacheMeasured = Object.values(accMap).some((a) => a.cacheUsageMeasured);

      const effectiveTestsPassed = testAnalysis.passed && gateEval.substanceErrors.length === 0;
      const compressedTestSummary = compressTestLog(
        checks.testRes.combined,
        repoInfo.testRunnerKind,
        { exitCode: effectiveTestsPassed ? 0 : Math.max(1, checks.testRes.exitCode) }
      ).compressed;
      const testsOutputSummary =
        gateEval.substanceErrors.length > 0 && testAnalysis.passed
          ? `${compressedTestSummary}\n[SUBSTANCE FAIL]: ${gateEval.substanceErrors.join('; ')}`
          : compressedTestSummary;

      return {
        side,
        provenance,
        promptTokens: sumAcc((a) => a.promptTokens),
        completionTokens: sumAcc((a) => a.completionTokens),
        cachedInputTokens: sumAcc((a) => a.cachedInputTokens),
        uncachedInputTokens: sumAcc((a) => a.uncachedInputTokens),
        thoughtsTokens: sumAcc((a) => a.thoughtsTokens),
        totalTokens: sumAcc((a) => a.totalTokens),
        costUsd: hasKnownCost ? Number(sumAcc((a) => a.costUsd).toFixed(6)) : null,
        cacheUsageMeasured: cacheMeasured,
        durationMs: sumAcc((a) => a.durationMs),
        toolCalls: 0,
        retries: sumAcc((a) => a.retries),
        reviewIterations: reviewIters,
        testsPassed: effectiveTestsPassed,
        testExitCode: checks.testRes.exitCode,
        lintExitCode: checks.lintRes.exitCode,
        acceptanceExitCode: acceptance?.exitCode ?? null,
        testsOutputSummary,
        lintPassed: checks.lintRes.exitCode === 0,
        lintOutputSummary:
          checks.lintRes.exitCode === 0
            ? '0 errors'
            : checks.lintRes.combined.trim().slice(0, 300) || `Lint failed (exit ${checks.lintRes.exitCode})`,
        reqCoveragePct,
        coveredReqs,
        uncoveredReqs: Array.from(uncoveredSet),
        artifactConsistency: specUnchanged && gateEval.consistencyErrors.length === 0,
        tasksCompleted: finalGraph.tasks.filter((t) => t.completed).length,
        tasksTotal: graph.tasks.length,
        changedFiles,
        diffLineCount: diffOut ? diffOut.split(/\r?\n/).length : 0,
        stages,
      };
    };

    const baselineSummary = buildSummary(
      'baseline',
      baselineRepoDir,
      baseAcc,
      baselineReviewIters,
      baseFinalChecks,
      baseFinalTestAnalysis,
      baseAcceptance,
      baseArtifacts.diff,
      baseArtifacts.changedFiles
    );
    const optimizedSummary = buildSummary(
      'spectrim',
      optimizedRepoDir,
      optAcc,
      optimizedReviewIters,
      optFinalChecks,
      optFinalTestAnalysis,
      optAcceptance,
      optArtifacts.diff,
      optArtifacts.changedFiles
    );

    const pct = (b: number, o: number) =>
      b > 0 ? Number((((b - o) / b) * 100).toFixed(1)) : null;

    const resolvedModels = new Set(telemetry.map(row => row.resolved_model));
    manifest.sameModelEnforced = resolvedModels.size === 1;
    manifest.status = 'completed';

    const limitations: string[] = [];
    if (isolationMode === 'snapshot_copy') {
      limitations.push(
        `snapshot_copy: две независимо проверенные копии, SHA-256 ${snapshotHash}. ${isolation.reason}`
      );
    } else if (gitCtx.repoSubpath) {
      limitations.push(
        `Полигон расположен во вложенном подкаталоге '${gitCtx.repoSubpath}' внутри родительского Git-репозитория (${gitCtx.gitRoot}); оба git worktree созданы от commit ${gitCtx.headCommit?.slice(0, 12)}, а команды и diff ограничены этим подкаталогом.`
      );
    }

    if (selectedProvider === 'ollama') {
      limitations.push(
        `Локальный прогон через Ollama (${providerStatus.ollamaStatus.baseUrl}, модель ${model}): prompt_eval_count и eval_count измерены локальным сервером без API-ключа; денежная стоимость равна n/a (нет облачного биллинга).`
      );
      limitations.push(
        'Ollama /api/chat не возвращает отдельный счётчик API-кэша (cachedInputTokens = 0, cacheUsageMeasured = false), поэтому KV-Cache prefix здесь влияет на локальную скорость, но не отражается в поле cachedInputTokens.'
      );
      limitations.push(
        'Качество кода, @spec:REQ-XX и прохождение тестов зависят от выбранной локальной модели и её квантизации; эталонным облачным прогоном для жюри остаётся Gemini Hydrogen.'
      );
    } else {
      if (!optimizedSummary.cacheUsageMeasured) {
        limitations.push(
          'Провайдер не вернул ненулевой cachedContentTokenCount для данного размера промпта; cachedInputTokens зафиксированы как 0 без домысливания.'
        );
      }
      if (baselineSummary.costUsd === null || optimizedSummary.costUsd === null) {
        limitations.push(
          `Тариф модели ${model} отсутствует в локальной таблице цен — стоимость в USD отмечена как n/a.`
        );
      }
    }

    const comparableUsage = usageComplete && manifest.sameModelEnforced;
    if (!manifest.sameModelEnforced) limitations.push('Provider responses identified different model versions.');
    if (!usageComplete) limitations.push('Some provider attempts returned no usage. Token and cost savings are unavailable.');
    const metricsJsonl = telemetry.map((t) => JSON.stringify(t)).join('\n');
    const meetsAcceptance = (side: PipelineSideSummary) =>
      side.testsPassed && side.lintPassed && side.acceptanceExitCode === 0 &&
      side.reqCoveragePct === 100 && side.artifactConsistency &&
      side.tasksTotal > 0 && side.tasksCompleted === side.tasksTotal;

    const report: AbRunReport = {
      manifest,
      provenance,
      usageComplete,
      limitations,
      baseline: baselineSummary,
      optimized: optimizedSummary,
      savings: {
        totalTokensPct: comparableUsage ? pct(baselineSummary.totalTokens, optimizedSummary.totalTokens) : null,
        promptTokensPct: comparableUsage ? pct(baselineSummary.promptTokens, optimizedSummary.promptTokens) : null,
        completionTokensPct: comparableUsage ? pct(
          baselineSummary.completionTokens,
          optimizedSummary.completionTokens
        ) : null,
        costPct:
          comparableUsage && baselineSummary.costUsd !== null && optimizedSummary.costUsd !== null
            ? pct(baselineSummary.costUsd, optimizedSummary.costUsd)
            : null,
        reviewIterationsDelta:
          baselineSummary.reviewIterations - optimizedSummary.reviewIterations,
        retriesDelta: baselineSummary.retries - optimizedSummary.retries,
        durationDeltaMs: baselineSummary.durationMs - optimizedSummary.durationMs,
      },
      qualityParityPassed: manifest.sameModelEnforced && meetsAcceptance(baselineSummary) && meetsAcceptance(optimizedSummary),
      baselineDiff: baseArtifacts.diff || '# No tracked file changes',
      optimizedDiff: optArtifacts.diff || '# No tracked file changes',
      metricsJsonl,
    };

    const deliverables = generateJuryDeliverables(report);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(runDir, 'baseline.diff'), report.baselineDiff);
    fs.writeFileSync(path.join(runDir, 'optimized.diff'), report.optimizedDiff);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), deliverables.reportMd);

    emit(
      'done',
      `Прогон ${runId} (${selectedProvider} / ${model}) завершён. Экономия: ${report.savings.totalTokensPct === null ? 'n/a' : report.savings.totalTokensPct + '%'} (${provenance}).`
    );
    return report;
  } catch (err) {
    const aborted = opts.signal?.aborted || (err instanceof Error && err.message.includes('aborted'));
    manifest.status = aborted ? 'cancelled' : 'failed';
    manifest.error = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    emit(aborted ? 'cancelled' : 'error', manifest.error);
    throw err;
  } finally {
    await isolation.cleanup();
  }
}
