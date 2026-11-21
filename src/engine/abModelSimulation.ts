import { AbRunReport, DataProvenance, SddStage, TelemetryEventRecord } from './provenance';

export type ModelTier = 'small' | 'large';

export interface SimulationConfig {
  modelTier: ModelTier;
  taskCount: number;
  baselineReviewIters: number;
  kvCacheHitRatePct: number;
  enableSpecSlicer: boolean;
  enableAstLodHashline: boolean;
  enableOutputCompressor: boolean;
  enablePreReviewGate: boolean;
  enableDeltaReviewAndCache: boolean;
}

export interface KvCacheSegment {
  order: number;
  slot: string;
  volatility: 'static' | 'task_scoped' | 'dynamic';
  tokens: number;
  cacheHit: boolean;
  description: string;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  modelTier: 'small',
  taskCount: 10,
  baselineReviewIters: 4,
  kvCacheHitRatePct: 85,
  enableSpecSlicer: true,
  enableAstLodHashline: true,
  enableOutputCompressor: true,
  enablePreReviewGate: true,
  enableDeltaReviewAndCache: true,
};

export function buildKvCacheLayout(enableDeltaReviewAndCache: boolean): KvCacheSegment[] {
  return [
    {
      order: 1,
      slot: 'Системный промпт + контракты инструментов (Hashline / AST)',
      volatility: 'static',
      tokens: 1400,
      cacheHit: enableDeltaReviewAndCache,
      description: 'Неизменяемый префикс для всей сессии и между задачами.',
    },
    {
      order: 2,
      slot: 'Замороженный Proposal & Glossary проекта',
      volatility: 'static',
      tokens: 480,
      cacheHit: enableDeltaReviewAndCache,
      description: 'Стабильный доменный словарь, не инвалидируется при правках кода.',
    },
    {
      order: 3,
      slot: 'Sliced Spec + Design (только для текущей задачи TSK-k)',
      volatility: 'task_scoped',
      tokens: 890,
      cacheHit: enableDeltaReviewAndCache,
      description: 'Фиксирован внутри всех шагов задачи TSK-k (чтение -> правка -> тест).',
    },
    {
      order: 4,
      slot: 'State Capsule @hash (экспортированные символы)',
      volatility: 'task_scoped',
      tokens: 210,
      cacheHit: enableDeltaReviewAndCache,
      description: 'Компактный JSON-слепок завершённых задач без истории диалога.',
    },
    {
      order: 5,
      slot: 'Динамический хвост: LOD0/LOD1 файлы + сжатый diff/лог',
      volatility: 'dynamic',
      tokens: 1180,
      cacheHit: false,
      description: 'Вынесен строго в конец промпта, чтобы не ломать префиксный кэш слотов 1–4.',
    },
  ];
}

/**
 * Explicit local mathematical simulation (provenance: 'simulated').
 * Never presented as measured provider telemetry.
 */
export function runLocalSimulation(
  partialConfig: Partial<SimulationConfig> = {}
): AbRunReport {
  const cfg: SimulationConfig = { ...DEFAULT_SIMULATION_CONFIG, ...partialConfig };
  const K = Math.max(4, Math.min(16, Math.round(cfg.taskCount)));
  const R_base = Math.max(2, Math.min(6, Math.round(cfg.baselineReviewIters)));
  const isSmall = cfg.modelTier === 'small';
  const provenance: DataProvenance = 'simulated';
  const modelLabel = isSmall
    ? 'simulated-small-llm-8b-32b (локальная модель)'
    : 'simulated-large-llm-frontier (локальная модель)';

  const baseRetryMultiplier = isSmall ? 1.32 : 1.08;
  const baseEditRetries = isSmall ? Math.round(K * 0.9) : Math.round(K * 0.3);

  const specPrepBaseIn = 6200;
  const specPrepBaseOut = 2400;
  const specPrepOptIn = cfg.enableSpecSlicer ? 3900 : specPrepBaseIn;
  const specPrepOptOut = cfg.enableAstLodHashline ? 1750 : specPrepBaseOut;
  const specPrepOptCached = cfg.enableDeltaReviewAndCache
    ? Math.round(specPrepOptIn * 0.45)
    : 0;

  let applyBaseIn = 0;
  let applyBaseOut = 0;
  for (let t = 1; t <= K; t++) {
    const turns = isSmall ? 3 : 2;
    for (let turn = 0; turn < turns; turn++) {
      applyBaseIn += Math.round((1400 + 4200 + t * 1450 + 1850) * (turn === 0 ? 1 : 1.08));
      applyBaseOut += isSmall ? 820 : 690;
    }
  }
  applyBaseIn = Math.round(applyBaseIn * baseRetryMultiplier * 0.72);
  applyBaseOut = Math.round(applyBaseOut * baseRetryMultiplier * 0.78);
  const applyBaseCached = Math.round(applyBaseIn * 0.14);

  const specFactor = cfg.enableSpecSlicer ? 0.24 : 1.0;
  const astFactor = cfg.enableAstLodHashline ? 0.34 : 1.0;
  const logFactor = cfg.enableOutputCompressor ? 0.22 : 1.0;
  const retrySavings = cfg.enableAstLodHashline && cfg.enableSpecSlicer ? 1.05 : baseRetryMultiplier;

  let applyOptIn = 0;
  let applyOptOut = 0;
  for (let t = 1; t <= K; t++) {
    const perTaskContext =
      1400 +
      Math.round(4200 * specFactor) +
      Math.round(2200 * astFactor) +
      Math.round(1600 * logFactor) +
      210;
    const turns = isSmall && !cfg.enableSpecSlicer ? 3 : 2;
    applyOptIn += Math.round(perTaskContext * turns * (retrySavings > 1.1 ? 1.15 : 1.0));
    applyOptOut += Math.round((cfg.enableAstLodHashline ? 390 : 710) * turns);
  }
  const cacheRate = cfg.enableDeltaReviewAndCache
    ? Math.max(0.2, Math.min(0.92, cfg.kvCacheHitRatePct / 100))
    : 0.12;
  const applyOptCached = Math.round(applyOptIn * cacheRate * 0.78);

  const reviewPerIterBaseIn = 9600 + K * 420;
  const reviewBaseIn = reviewPerIterBaseIn * R_base;
  const reviewBaseOut = 1850 * R_base;
  const reviewBaseCached = Math.round(reviewBaseIn * 0.18);

  const R_opt = cfg.enablePreReviewGate ? 1 : Math.max(2, R_base - 1);
  const deltaFactor = cfg.enableDeltaReviewAndCache ? 0.42 : 1.0;
  const astReviewFactor = cfg.enableAstLodHashline ? 0.65 : 1.0;
  const reviewOptIn = Math.round(reviewPerIterBaseIn * deltaFactor * astReviewFactor * R_opt);
  const reviewOptOut = Math.round((cfg.enableAstLodHashline ? 920 : 1650) * R_opt);
  const reviewOptCached = cfg.enableDeltaReviewAndCache
    ? Math.round(reviewOptIn * cacheRate * 0.85)
    : 0;

  const verifyBaseIn = 7800 + K * 260;
  const verifyBaseOut = 1400;
  const verifyBaseCached = Math.round(verifyBaseIn * 0.15);
  const verifyOptIn = cfg.enablePreReviewGate ? 1450 : Math.round(verifyBaseIn * 0.65);
  const verifyOptOut = cfg.enablePreReviewGate ? 320 : 980;
  const verifyOptCached = cfg.enableDeltaReviewAndCache ? Math.round(verifyOptIn * 0.75) : 0;

  const mkStage = (
    stage: SddStage,
    stageLabel: string,
    promptTokens: number,
    cachedInputTokens: number,
    completionTokens: number,
    toolCalls: number,
    retries: number,
    durationMs: number
  ) => ({
    stage,
    stageLabel,
    promptTokens,
    completionTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, promptTokens - cachedInputTokens),
    thoughtsTokens: 0,
    totalTokens: promptTokens + completionTokens,
    durationMs,
    toolCalls,
    retries,
    provenance,
  });

  const baseStages = [
    mkStage('spec_prep', 'Спецификация (Propose / Sync)', specPrepBaseIn, Math.round(specPrepBaseIn * 0.2), specPrepBaseOut, 5, 0, 4200),
    mkStage('apply', 'Реализация задач (Apply)', applyBaseIn, applyBaseCached, applyBaseOut, K * 6, baseEditRetries, K * 3200),
    mkStage('review', 'Ревью (Review Cycles)', reviewBaseIn, reviewBaseCached, reviewBaseOut, R_base * 4, 0, R_base * 2900),
    mkStage('verify', 'Верификация (Verify & Audit)', verifyBaseIn, verifyBaseCached, verifyBaseOut, 4, 0, 2100),
  ];

  const optRetries = cfg.enableAstLodHashline ? 0 : Math.max(1, Math.floor(baseEditRetries / 2));
  const optStages = [
    mkStage('spec_prep', 'Спецификация (Propose / Sync)', specPrepOptIn, specPrepOptCached, specPrepOptOut, 2, 0, 2400),
    mkStage('apply', 'Реализация задач (Apply)', applyOptIn, applyOptCached, applyOptOut, K * 3, optRetries, K * 1800),
    mkStage('review', 'Ревью (Review Cycles)', reviewOptIn, reviewOptCached, reviewOptOut, R_opt * 2, 0, R_opt * 1600),
    mkStage('verify', 'Верификация (Verify & Audit)', verifyOptIn, verifyOptCached, verifyOptOut, 1, 0, 900),
  ];

  const sumStages = (
    side: 'baseline' | 'spectrim',
    stages: typeof baseStages,
    reviewIterations: number,
    reqCoveragePct: number
  ) => {
    const promptTokens = stages.reduce((a, s) => a + s.promptTokens, 0);
    const completionTokens = stages.reduce((a, s) => a + s.completionTokens, 0);
    const cachedInputTokens = stages.reduce((a, s) => a + s.cachedInputTokens, 0);
    const uncachedInputTokens = Math.max(0, promptTokens - cachedInputTokens);
    const totalTokens = promptTokens + completionTokens;
    const durationMs = stages.reduce((a, s) => a + s.durationMs, 0);
    const toolCalls = stages.reduce((a, s) => a + s.toolCalls, 0);
    const retries = stages.reduce((a, s) => a + s.retries, 0);
    const costUsd = Number(
      (((uncachedInputTokens * 0.15 + cachedInputTokens * 0.015 + completionTokens * 0.6) / 1_000_000)).toFixed(4)
    );
    const allReqs = Array.from({ length: K }, (_, i) => `REQ-${String(i + 1).padStart(2, '0')}`);

    return {
      side,
      provenance,
      promptTokens,
      completionTokens,
      cachedInputTokens,
      uncachedInputTokens,
      thoughtsTokens: 0,
      totalTokens,
      costUsd,
      cacheUsageMeasured: false,
      durationMs,
      toolCalls,
      retries,
      reviewIterations,
      testsPassed: true,
      testsOutputSummary: 'Simulated fixture (не реальный запуск тест-раннера)',
      lintPassed: true,
      lintOutputSummary: 'Simulated fixture',
      reqCoveragePct,
      coveredReqs: reqCoveragePct === 100 ? allReqs : allReqs.slice(0, K - 1),
      uncoveredReqs: reqCoveragePct === 100 ? [] : [allReqs[K - 1]],
      artifactConsistency: true,
      tasksCompleted: K,
      tasksTotal: K,
      changedFiles: [],
      diffLineCount: 0,
      stages,
    };
  };

  const baseline = sumStages('baseline', baseStages, R_base, isSmall ? 90 : 100);
  const optimized = sumStages('spectrim', optStages, R_opt, 100);

  const pct = (b: number, o: number) =>
    b > 0 ? Number((((b - o) / b) * 100).toFixed(1)) : 0;

  const records: TelemetryEventRecord[] = [];
  const baseTs = Date.now();
  let sec = 0;
  for (const s of baseStages) {
    sec += 5;
    records.push({
      ts: new Date(baseTs + sec * 1000).toISOString(),
      run: 'baseline',
      provider: 'local_simulation',
      model: modelLabel,
      stage: s.stage,
      task_id: s.stage.toUpperCase(),
      prompt_tokens: s.promptTokens,
      completion_tokens: s.completionTokens,
      cached_input_tokens: s.cachedInputTokens,
      uncached_input_tokens: s.uncachedInputTokens,
      thoughts_tokens: 0,
      total_tokens: s.totalTokens,
      tool_calls: s.toolCalls,
      retries: s.retries,
      review_iteration: s.stage === 'review' ? R_base : 0,
      duration_ms: s.durationMs,
      cost_usd: null,
      cache_usage_measured: false,
      provenance: 'simulated',
    });
  }
  for (const s of optStages) {
    sec += 5;
    records.push({
      ts: new Date(baseTs + sec * 1000).toISOString(),
      run: 'spectrim',
      provider: 'local_simulation',
      model: modelLabel,
      stage: s.stage,
      task_id: s.stage.toUpperCase(),
      prompt_tokens: s.promptTokens,
      completion_tokens: s.completionTokens,
      cached_input_tokens: s.cachedInputTokens,
      uncached_input_tokens: s.uncachedInputTokens,
      thoughts_tokens: 0,
      total_tokens: s.totalTokens,
      tool_calls: s.toolCalls,
      retries: s.retries,
      review_iteration: s.stage === 'review' ? R_opt : 0,
      duration_ms: s.durationMs,
      cost_usd: null,
      cache_usage_measured: false,
      provenance: 'simulated',
    });
  }

  return {
    manifest: {
      runId: 'local-simulation-preview',
      createdAt: new Date(baseTs).toISOString(),
      repoPath: 'benchmarks/orders-ts',
      repoName: 'orders-service-ts',
      changeId: 'add-idempotency-and-webhooks',
      baseCommit: 'simulated',
      provider: 'local_simulation',
      model: modelLabel,
      sameModelEnforced: true,
      detectedLanguage: 'typescript',
      testCommand: 'npx tsx --test tests/*.test.ts',
      lintCommand: 'npx tsc --noEmit',
      baselineWorktree: 'none (local simulation)',
      optimizedWorktree: 'none (local simulation)',
      status: 'completed',
    },
    provenance: 'simulated',
    limitations: [
      'Это ЛОКАЛЬНАЯ МАТЕМАТИЧЕСКАЯ СИМУЛЯЦИЯ (provenance: simulated). Она НЕ является измеренным доказательством экономии через API провайдера.',
      'Для получения достоверных данных provenance: measured запустите реальный A/B worktree-прогон с настроенным GEMINI_API_KEY или OpenAI-compatible endpoint.',
    ],
    baseline,
    optimized,
    savings: {
      totalTokensPct: pct(baseline.totalTokens, optimized.totalTokens),
      promptTokensPct: pct(baseline.promptTokens, optimized.promptTokens),
      completionTokensPct: pct(baseline.completionTokens, optimized.completionTokens),
      costPct:
        baseline.costUsd && optimized.costUsd !== null
          ? pct(baseline.costUsd, optimized.costUsd)
          : null,
      reviewIterationsDelta: baseline.reviewIterations - optimized.reviewIterations,
      retriesDelta: baseline.retries - optimized.retries,
      durationDeltaMs: baseline.durationMs - optimized.durationMs,
    },
    qualityParityPassed: true,
    baselineDiff: '# Simulated run — real git diff appears on worktree execution',
    optimizedDiff: '# Simulated run — real git diff appears on worktree execution',
    metricsJsonl: records.map((r) => JSON.stringify(r)).join('\n'),
  };
}
