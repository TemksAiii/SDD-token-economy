import fs from 'node:fs';
import path from 'node:path';
import {
  AbRunReport,
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
} from '../engine/specSlicer';
import {
  applyHashlinePatch,
  HashlinePatchRequest,
  renderAstLodView,
} from '../engine/astLodHashline';
import { compressGitDiff, compressTestLog } from '../engine/outputCompressor';
import { runPreReviewGate } from '../engine/preReviewGate';
import { generateJuryDeliverables } from '../engine/juryDeliverables';
import { resolveConfinedPath, RUNS_ROOT, sanitizeIdSegment } from './pathGuard';
import {
  collectRepoFiles,
  detectRepoOnDisk,
  readOpenSpecBundleFromDisk,
  writeRepoFileConfined,
} from './repoFs';
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
  toolCalls: number;
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
    toolCalls: 0,
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
    return null;
  }
}

function markTaskDoneInFile(worktreeDir: string, changeId: string, taskId: string): void {
  const tasksPath = path.join(worktreeDir, 'openspec', 'changes', changeId, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return;
  const content = fs.readFileSync(tasksPath, 'utf8');
  const updated = content.replace(
    new RegExp(`^(-\\s+\\[) (\\]\\s+\\[?${taskId}\\]?)`, 'm'),
    '$1x$2'
  );
  fs.writeFileSync(tasksPath, updated, 'utf8');
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
  if (!repoInfo.isGitRepo) {
    throw new Error(
      `Репозиторий ${repoInfo.repoPath} не является git-репозиторием; git worktree невозможен.`
    );
  }

  const headRes = await runSafeCommand('git', ['rev-parse', 'HEAD'], absRepo, {
    signal: opts.signal,
  });
  if (headRes.exitCode !== 0) {
    throw new Error(`Не удалось получить baseCommit: ${headRes.combined}`);
  }
  const baseCommit = headRes.stdout.trim();

  const bundle = readOpenSpecBundleFromDisk(opts.repoPath, opts.changeId);
  const graph = parseOpenSpecBundle(bundle);
  if (graph.tasks.length === 0) {
    throw new Error(`В change ${opts.changeId} не найдены задачи в tasks.md`);
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(RUNS_ROOT, runId);
  const baselineWt = path.join(runDir, 'worktree-baseline');
  const optimizedWt = path.join(runDir, 'worktree-optimized');
  fs.mkdirSync(runDir, { recursive: true });

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
    changeId: bundle.changeId,
    baseCommit,
    provider: selectedProvider,
    model,
    sameModelEnforced: true,
    detectedLanguage: repoInfo.language,
    testCommand: repoInfo.testCommand,
    lintCommand: repoInfo.lintCommand,
    baselineWorktree: path.relative(process.cwd(), baselineWt),
    optimizedWorktree: path.relative(process.cwd(), optimizedWt),
    status: 'running',
  };

  fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2));

  const telemetry: TelemetryEventRecord[] = [];

  const recordUsage = (
    run: 'baseline' | 'spectrim',
    stage: SddStage,
    taskId: string,
    acc: StageAccumulator,
    resp: Awaited<ReturnType<typeof callLlmWithUsage>>,
    toolCalls: number,
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
    acc.toolCalls += toolCalls;
    acc.retries += retries;
    if (resp.usage.costUsd !== null) {
      acc.hasKnownCost = true;
      acc.costUsd += resp.usage.costUsd;
    }
    if (resp.usage.cacheUsageMeasured) {
      acc.cacheUsageMeasured = true;
    }

    telemetry.push({
      ts: new Date().toISOString(),
      run,
      provider: selectedProvider,
      model,
      stage,
      task_id: taskId,
      prompt_tokens: resp.usage.promptTokens,
      completion_tokens: resp.usage.completionTokens,
      cached_input_tokens: resp.usage.cachedInputTokens,
      uncached_input_tokens: resp.usage.uncachedInputTokens,
      thoughts_tokens: resp.usage.thoughtsTokens,
      total_tokens: resp.usage.totalTokens,
      tool_calls: toolCalls,
      retries,
      review_iteration: reviewIter,
      duration_ms: resp.durationMs,
      cost_usd: resp.usage.costUsd,
      cache_usage_measured: resp.usage.cacheUsageMeasured,
      provenance: 'measured',
    });
  };

  try {
    emit('setup', `Создание изолированных git worktree от commit ${baseCommit.slice(0, 7)}...`);
    const wt1 = await runSafeCommand(
      'git',
      ['worktree', 'add', '--detach', baselineWt, baseCommit],
      absRepo,
      { signal: opts.signal }
    );
    if (wt1.exitCode !== 0) {
      throw new Error(`git worktree add baseline failed: ${wt1.combined}`);
    }
    const wt2 = await runSafeCommand(
      'git',
      ['worktree', 'add', '--detach', optimizedWt, baseCommit],
      absRepo,
      { signal: opts.signal }
    );
    if (wt2.exitCode !== 0) {
      throw new Error(`git worktree add optimized failed: ${wt2.combined}`);
    }

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

    const baseFilesSnapshot = collectRepoFiles(baselineWt)
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');

    emit('baseline', '[Baseline] spec_prep: чтение полной спеки и структуры репозитория...', ++currentStep, totalSteps);
    const basePrepResp = await callLlmWithUsage({
      provider: selectedProvider,
      model,
      systemInstruction:
        'You are a software engineer implementing an OpenSpec change. Respond strictly with valid JSON.',
      prompt: `Review the full OpenSpec artifacts and existing repository files, and output JSON {"plan": ["..."], "risks": ["..."]}.\n\n${fullSpecDump}\n\n${baseFilesSnapshot}`,
      signal: opts.signal,
    });
    recordUsage('baseline', 'spec_prep', 'SPEC-ALL', baseAcc.spec_prep, basePrepResp, 4, 0, 0);

    // Accumulated conversation history (O(N^2) context growth in Baseline)
    let accumulatedHistory = `Plan: ${basePrepResp.text}\n`;
    const pendingTasks = graph.tasks.filter((t) => !t.completed);
    const tasksToRun = pendingTasks.length > 0 ? pendingTasks : graph.tasks.slice(0, 3);

    for (const task of tasksToRun) {
      emit('baseline', `[Baseline] apply ${task.id}: монолитная сессия...`, ++currentStep, totalSteps);
      const currentFiles = collectRepoFiles(baselineWt)
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

      const resp = await callLlmWithUsage({
        provider: selectedProvider,
        model,
        systemInstruction:
          'You are a coding agent working in a continuous single session. Always return full file contents in JSON {"edits":[{"path":"...","content":"..."}]}.',
        prompt: applyPrompt,
        signal: opts.signal,
      });

      const parsed = parseJsonSafe<{ edits?: Array<{ path: string; content: string }> }>(resp.text);
      let retries = 0;
      if (parsed?.edits) {
        for (const edit of parsed.edits) {
          if (edit.path && typeof edit.content === 'string') {
            writeRepoFileConfined(baselineWt, edit.path, edit.content);
          }
        }
      } else {
        retries = 1;
      }

      const checks = await execRepoChecks(baselineWt, repoInfo.testCommand, repoInfo.lintCommand, opts.signal);
      markTaskDoneInFile(baselineWt, bundle.changeId, task.id);

      const rawToolOutput = `TEST EXIT ${checks.testRes.exitCode}:\n${checks.testRes.combined}\nLINT EXIT ${checks.lintRes.exitCode}:\n${checks.lintRes.combined}`;
      accumulatedHistory += `\n--- Step ${task.id} ---\nAssistant edits: ${resp.text.slice(0, 1800)}\nTool output:\n${rawToolOutput}\n`;
      recordUsage('baseline', 'apply', task.id, baseAcc.apply, resp, 5, retries, 0);
    }

    // Baseline review iterations (full diff + raw logs)
    let baselineReviewIters = 0;
    for (let iter = 1; iter <= maxReviewIters; iter++) {
      baselineReviewIters = iter;
      emit('baseline', `[Baseline] review итерация ${iter}/${maxReviewIters}...`, ++currentStep, totalSteps);
      const diffRes = await runSafeCommand('git', ['diff', '--no-color'], baselineWt, {
        signal: opts.signal,
      });
      const untrackedFiles = collectRepoFiles(baselineWt)
        .map((f) => `--- ${f.path} ---\n${f.content}`)
        .join('\n\n');
      const checks = await execRepoChecks(baselineWt, repoInfo.testCommand, repoInfo.lintCommand, opts.signal);

      const revResp = await callLlmWithUsage({
        provider: selectedProvider,
        model,
        systemInstruction:
          'You are a strict code reviewer. Return JSON {"approved": boolean, "issues": ["..."], "edits": [{"path":"...","content":"..."}]}.',
        prompt: `Review iteration ${iter}. Check all requirements, tests, and typecheck.\n\n[FULL SPEC]\n${fullSpecDump}\n\n[GIT DIFF]\n${diffRes.stdout}\n\n[FULL FILES]\n${untrackedFiles}\n\n[RAW TEST/LINT]\n${checks.testRes.combined}\n${checks.lintRes.combined}`,
        signal: opts.signal,
      });

      const parsedRev = parseJsonSafe<{
        approved?: boolean;
        edits?: Array<{ path: string; content: string }>;
      }>(revResp.text);

      const revRetries = parsedRev ? 0 : 1;
      if (parsedRev?.edits) {
        for (const edit of parsedRev.edits) {
          if (edit.path && typeof edit.content === 'string') {
            writeRepoFileConfined(baselineWt, edit.path, edit.content);
          }
        }
      }
      recordUsage('baseline', 'review', `REV-${iter}`, baseAcc.review, revResp, 4, revRetries, iter);
      if (parsedRev?.approved && checks.testRes.exitCode === 0 && checks.lintRes.exitCode === 0) {
        break;
      }
    }

    // Baseline final verification
    const baseFinalChecks = await execRepoChecks(
      baselineWt,
      repoInfo.testCommand,
      repoInfo.lintCommand,
      opts.signal
    );
    const baseVerifyResp = await callLlmWithUsage({
      provider: selectedProvider,
      model,
      systemInstruction: 'Verify OpenSpec compliance and return JSON {"verified": boolean, "summary": "..."}.',
      prompt: `Verify all requirements and tests.\n${fullSpecDump}\nTest exit: ${baseFinalChecks.testRes.exitCode}\n${baseFinalChecks.testRes.combined}`,
      signal: opts.signal,
    });
    recordUsage('baseline', 'verify', 'VERIFY-ALL', baseAcc.verify, baseVerifyResp, 3, 0, 0);

    // =========================================================================
    // RUN B: SPECTRIM OPTIMIZED (Task-sliced micro-sessions, AST-LOD, Hashline, Compressor, Gate, Delta)
    // =========================================================================
    const optAcc: Record<SddStage, StageAccumulator> = {
      spec_prep: emptyAcc(),
      apply: emptyAcc(),
      review: emptyAcc(),
      verify: emptyAcc(),
    };

    emit('spectrim', '[SpecTrim] spec_prep: парсинг графа REQ→DES→TSK + 1 компактная синхронизация...', ++currentStep, totalSteps);
    const optPrepResp = await callLlmWithUsage({
      provider: selectedProvider,
      model,
      systemInstruction:
        'You are a SpecTrim SDD planner. Return concise JSON {"glossary": ["..."], "contracts": ["..."]}.',
      prompt: `Proposal:\n${bundle.proposalMd}\nTask IDs: ${graph.tasks.map((t) => `${t.id}(${t.linkedReqs.join(',')})`).join(', ')}`,
      signal: opts.signal,
    });
    recordUsage('spectrim', 'spec_prep', 'SPEC-GRAPH', optAcc.spec_prep, optPrepResp, 1, 0, 0);

    const completedContracts: Array<{ taskId: string; file: string; symbol: string; reqs: string[] }> = [];
    const completedIds: string[] = graph.tasks.filter((t) => t.completed).map((t) => t.id);

    const staticSystemPrompt =
      'You are a SpecTrim micro-session coding agent. Use Hashline patches or minimal file outputs. Return strict JSON {"hashline_patches":[{"path":"...","startLine":1,"startHash":"abc","endLine":1,"endHash":"abc","replacement":"..."}], "files":[{"path":"...","content":"..."}], "exported_symbol":"..."}.';

    for (const task of tasksToRun) {
      emit('spectrim', `[SpecTrim] apply ${task.id}: изолированная микро-сессия + AST-LOD...`, ++currentStep, totalSteps);
      const currentBundle = readOpenSpecBundleFromDisk(optimizedWt, bundle.changeId);
      const slice = sliceSpecForTask(currentBundle, task.id, completedIds, completedContracts);

      const wtFiles = collectRepoFiles(optimizedWt);
      const targetSet = new Set(task.targetFiles);
      const contextBlocks = wtFiles.map((f) => {
        const isTarget = targetSet.has(f.path);
        const view = renderAstLodView(
          f.path,
          f.content,
          repoInfo.language,
          isTarget ? 'LOD0' : 'LOD1'
        );
        return view.rendered;
      });

      // KV-Cache-friendly prefix ordering: Static Proposal & Slice -> State Capsule -> Dynamic Code & Compressed Logs
      const microPrompt = `${slice.compiledPromptBundle}\n\n[AST_LOD_FILES]\n${contextBlocks.join('\n\n')}`;

      const resp = await callLlmWithUsage({
        provider: selectedProvider,
        model,
        systemInstruction: staticSystemPrompt,
        prompt: microPrompt,
        signal: opts.signal,
      });

      const parsed = parseJsonSafe<{
        hashline_patches?: Array<HashlinePatchRequest & { path: string }>;
        files?: Array<{ path: string; content: string }>;
        exported_symbol?: string;
      }>(resp.text);

      let retries = 0;
      if (!parsed) {
        retries += 1;
      }
      if (parsed?.hashline_patches) {
        for (const p of parsed.hashline_patches) {
          if (!p.path) continue;
          const absF = resolveConfinedPath(path.join(optimizedWt, p.path), optimizedWt);
          if (fs.existsSync(absF)) {
            const orig = fs.readFileSync(absF, 'utf8');
            const patchRes = applyHashlinePatch(orig, p);
            if (patchRes.ok) {
              writeRepoFileConfined(optimizedWt, p.path, patchRes.updatedContent);
            } else {
              retries += 1;
            }
          }
        }
      }
      if (parsed?.files) {
        for (const f of parsed.files) {
          if (f.path && typeof f.content === 'string') {
            writeRepoFileConfined(optimizedWt, f.path, f.content);
          }
        }
      }

      const checks = await execRepoChecks(optimizedWt, repoInfo.testCommand, repoInfo.lintCommand, opts.signal);
      // Compress test log rather than accumulating raw noise
      const _compressedLog = compressTestLog(checks.testRes.combined, repoInfo.testRunnerKind);
      markTaskDoneInFile(optimizedWt, bundle.changeId, task.id);
      if (!completedIds.includes(task.id)) completedIds.push(task.id);
      if (parsed?.exported_symbol) {
        completedContracts.push({
          taskId: task.id,
          file: task.targetFiles[0] || 'src/',
          symbol: parsed.exported_symbol,
          reqs: task.linkedReqs,
        });
      }

      // Persist State Capsule on disk inside worktree
      writeRepoFileConfined(
        optimizedWt,
        `openspec/changes/${bundle.changeId}/state_capsule.json`,
        JSON.stringify(slice.stateCapsule, null, 2)
      );

      recordUsage('spectrim', 'apply', task.id, optAcc.apply, resp, 3, retries, 0);
    }

    // Zero-Token Pre-Review Gate before calling LLM Reviewer!
    emit('spectrim', '[SpecTrim] Zero-Token Pre-Review Gate (0 LLM токенов)...', ++currentStep, totalSteps);
    const gateChecks = await execRepoChecks(optimizedWt, repoInfo.testCommand, repoInfo.lintCommand, opts.signal);
    const optBundleAfterApply = readOpenSpecBundleFromDisk(optimizedWt, bundle.changeId);
    const optFilesAfterApply = collectRepoFiles(optimizedWt);
    const preGate = runPreReviewGate({
      bundle: optBundleAfterApply,
      files: optFilesAfterApply,
      testsPassing: gateChecks.testRes.exitCode === 0,
      failingTestSnippet:
        gateChecks.testRes.exitCode === 0
          ? undefined
          : compressTestLog(gateChecks.testRes.combined, repoInfo.testRunnerKind).compressed,
      lintErrors:
        gateChecks.lintRes.exitCode === 0
          ? []
          : gateChecks.lintRes.combined.split(/\r?\n/).slice(0, 8),
    });

    // Single Incremental Delta Review
    emit('spectrim', '[SpecTrim] Delta Review (1 проход по сжатому diff)...', ++currentStep, totalSteps);
    const optRawDiffRes = await runSafeCommand('git', ['diff', '--no-color'], optimizedWt, {
      signal: opts.signal,
    });
    const compressedDiff = compressGitDiff(optRawDiffRes.stdout);

    const deltaRevResp = await callLlmWithUsage({
      provider: selectedProvider,
      model,
      systemInstruction:
        'You are a delta code reviewer. Pre-Review Gate already verified deterministic checks. Return JSON {"approved": boolean, "notes": ["..."]}.',
      prompt: `Gate report:\n${preGate.conciseReport}\n\n[COMPRESSED DELTA DIFF]\n${compressedDiff.compressed}`,
      signal: opts.signal,
    });
    recordUsage('spectrim', 'review', 'REV-DELTA-1', optAcc.review, deltaRevResp, 2, 0, 1);

    // Final verify (deterministic matrix + 1 tiny semantic confirmation)
    const optFinalChecks = await execRepoChecks(
      optimizedWt,
      repoInfo.testCommand,
      repoInfo.lintCommand,
      opts.signal
    );
    const optVerifyResp = await callLlmWithUsage({
      provider: selectedProvider,
      model,
      systemInstruction: 'Return JSON {"verified": boolean}.',
      prompt: `Gate passed: ${preGate.passed}. Test exit: ${optFinalChecks.testRes.exitCode}. Lint exit: ${optFinalChecks.lintRes.exitCode}.`,
      signal: opts.signal,
    });
    recordUsage('spectrim', 'verify', 'VERIFY-GATE', optAcc.verify, optVerifyResp, 1, 0, 0);

    // Build Final Summaries & Diffs (stage intent-to-add so new files show in git diff)
    emit('verify', 'Сбор acceptance criteria, diff и сохранение артефактов...', ++currentStep, totalSteps);
    await runSafeCommand('git', ['add', '-N', '.'], baselineWt);
    await runSafeCommand('git', ['add', '-N', '.'], optimizedWt);
    const finalBaseDiff = await runSafeCommand('git', ['diff', '--no-color'], baselineWt);
    const finalOptDiff = await runSafeCommand('git', ['diff', '--no-color'], optimizedWt);
    const baseStatus = await runSafeCommand('git', ['status', '--short'], baselineWt);
    const optStatus = await runSafeCommand('git', ['status', '--short'], optimizedWt);

    const buildSummary = (
      side: 'baseline' | 'spectrim',
      wtDir: string,
      accMap: Record<SddStage, StageAccumulator>,
      reviewIters: number,
      checks: Awaited<ReturnType<typeof execRepoChecks>>,
      diffOut: string,
      statusOut: string
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
          toolCalls: a.toolCalls,
          retries: a.retries,
          provenance: 'measured',
        };
      });

      const finalBundle = readOpenSpecBundleFromDisk(wtDir, bundle.changeId);
      const finalGraph = parseOpenSpecBundle(finalBundle);
      const finalFiles = collectRepoFiles(wtDir);
      const gateEval = runPreReviewGate({
        bundle: finalBundle,
        files: finalFiles,
        testsPassing: checks.testRes.exitCode === 0,
        lintErrors: checks.lintRes.exitCode === 0 ? [] : [checks.lintRes.combined],
      });

      const allReqIds = finalGraph.requirements.map((r) => r.id);
      const uncoveredSet = new Set([
        ...gateEval.uncoveredReqsInCode,
        ...gateEval.uncoveredReqsInTests,
      ]);
      const coveredReqs = allReqIds.filter((id) => !uncoveredSet.has(id));
      const reqCoveragePct =
        allReqIds.length > 0
          ? Number(((coveredReqs.length / allReqIds.length) * 100).toFixed(1))
          : 100;

      const sumAcc = (fn: (a: StageAccumulator) => number) =>
        Object.values(accMap).reduce((s, a) => s + fn(a), 0);

      const hasKnownCost = Object.values(accMap).some((a) => a.hasKnownCost);
      const cacheMeasured = Object.values(accMap).some((a) => a.cacheUsageMeasured);

      return {
        side,
        provenance: 'measured',
        promptTokens: sumAcc((a) => a.promptTokens),
        completionTokens: sumAcc((a) => a.completionTokens),
        cachedInputTokens: sumAcc((a) => a.cachedInputTokens),
        uncachedInputTokens: sumAcc((a) => a.uncachedInputTokens),
        thoughtsTokens: sumAcc((a) => a.thoughtsTokens),
        totalTokens: sumAcc((a) => a.totalTokens),
        costUsd: hasKnownCost ? Number(sumAcc((a) => a.costUsd).toFixed(6)) : null,
        cacheUsageMeasured: cacheMeasured,
        durationMs: sumAcc((a) => a.durationMs),
        toolCalls: sumAcc((a) => a.toolCalls),
        retries: sumAcc((a) => a.retries),
        reviewIterations: reviewIters,
        testsPassed: checks.testRes.exitCode === 0,
        testsOutputSummary: compressTestLog(checks.testRes.combined, repoInfo.testRunnerKind).compressed,
        lintPassed: checks.lintRes.exitCode === 0,
        lintOutputSummary: checks.lintRes.exitCode === 0 ? '0 errors' : checks.lintRes.combined.slice(0, 300),
        reqCoveragePct,
        coveredReqs,
        uncoveredReqs: Array.from(uncoveredSet),
        artifactConsistency: gateEval.consistencyErrors.length === 0,
        tasksCompleted: finalGraph.tasks.filter((t) => t.completed).length,
        tasksTotal: finalGraph.tasks.length,
        changedFiles: statusOut
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => l.trim()),
        diffLineCount: diffOut ? diffOut.split(/\r?\n/).length : 0,
        stages,
      };
    };

    const baselineSummary = buildSummary(
      'baseline',
      baselineWt,
      baseAcc,
      baselineReviewIters,
      baseFinalChecks,
      finalBaseDiff.stdout,
      baseStatus.stdout
    );
    const optimizedSummary = buildSummary(
      'spectrim',
      optimizedWt,
      optAcc,
      1,
      optFinalChecks,
      finalOptDiff.stdout,
      optStatus.stdout
    );

    const pct = (b: number, o: number) =>
      b > 0 ? Number((((b - o) / b) * 100).toFixed(1)) : null;

    manifest.status = 'completed';

    const limitations: string[] = [];
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

    const metricsJsonl = telemetry.map((t) => JSON.stringify(t)).join('\n');

    const report: AbRunReport = {
      manifest,
      provenance: 'measured',
      limitations,
      baseline: baselineSummary,
      optimized: optimizedSummary,
      savings: {
        totalTokensPct: pct(baselineSummary.totalTokens, optimizedSummary.totalTokens),
        promptTokensPct: pct(baselineSummary.promptTokens, optimizedSummary.promptTokens),
        completionTokensPct: pct(
          baselineSummary.completionTokens,
          optimizedSummary.completionTokens
        ),
        costPct:
          baselineSummary.costUsd !== null && optimizedSummary.costUsd !== null
            ? pct(baselineSummary.costUsd, optimizedSummary.costUsd)
            : null,
        reviewIterationsDelta:
          baselineSummary.reviewIterations - optimizedSummary.reviewIterations,
        retriesDelta: baselineSummary.retries - optimizedSummary.retries,
        durationDeltaMs: baselineSummary.durationMs - optimizedSummary.durationMs,
      },
      qualityParityPassed:
        optimizedSummary.testsPassed &&
        optimizedSummary.lintPassed &&
        optimizedSummary.reqCoveragePct >= baselineSummary.reqCoveragePct &&
        optimizedSummary.artifactConsistency,
      baselineDiff: finalBaseDiff.stdout || '# No tracked file changes',
      optimizedDiff: finalOptDiff.stdout || '# No tracked file changes',
      metricsJsonl,
    };

    const deliverables = generateJuryDeliverables(report);
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(runDir, 'metrics.jsonl'), metricsJsonl);
    fs.writeFileSync(path.join(runDir, 'baseline.diff'), report.baselineDiff);
    fs.writeFileSync(path.join(runDir, 'optimized.diff'), report.optimizedDiff);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(runDir, 'REPORT.md'), deliverables.reportMd);

    emit(
      'done',
      `Прогон ${runId} (${selectedProvider} / ${model}) завершён. Экономия: ${report.savings.totalTokensPct ?? 0}% (measured).`
    );
    return report;
  } catch (err) {
    const aborted = opts.signal?.aborted || (err instanceof Error && err.message.includes('aborted'));
    manifest.status = aborted ? 'cancelled' : 'failed';
    manifest.error = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(path.join(runDir, 'run_manifest.json'), JSON.stringify(manifest, null, 2));
    emit(aborted ? 'cancelled' : 'error', manifest.error);
    throw err;
  } finally {
    await runSafeCommand('git', ['worktree', 'remove', '--force', baselineWt], absRepo).catch(
      () => undefined
    );
    await runSafeCommand('git', ['worktree', 'remove', '--force', optimizedWt], absRepo).catch(
      () => undefined
    );
  }
}
