export type ModelTier = 'small' | 'large';
export type SddStage = 'spec_prep' | 'apply' | 'review' | 'verify';

export interface BenchmarkConfig {
  modelTier: ModelTier;
  taskCount: number; // K in [6..16], default 10
  baselineReviewIters: number; // R in [2..6], default 4
  kvCacheHitRatePct: number; // 0..92%, default 85
  enableSpecSlicer: boolean;
  enableAstLodHashline: boolean;
  enableOutputCompressor: boolean;
  enablePreReviewGate: boolean;
  enableDeltaReviewAndCache: boolean;
}

export interface StageTokenMetrics {
  stage: SddStage;
  stageLabel: string;
  baselineInput: number;
  baselineCached: number;
  baselineOutput: number;
  baselineTotal: number;
  optimizedInput: number;
  optimizedCached: number;
  optimizedOutput: number;
  optimizedTotal: number;
  savingsPct: number;
  rootCauseNote: string;
}

export interface QualityParityMetrics {
  baselineReqCoveragePct: number;
  optimizedReqCoveragePct: number;
  baselineTestsGreenPct: number;
  optimizedTestsGreenPct: number;
  baselineArtifactConsistency: boolean;
  optimizedArtifactConsistency: boolean;
  baselineFirstPassTaskRatePct: number;
  optimizedFirstPassTaskRatePct: number;
  baselineReviewIterations: number;
  optimizedReviewIterations: number;
  baselineEditRetries: number;
  optimizedEditRetries: number;
}

export interface TelemetryEventRecord {
  ts: string;
  run: 'baseline' | 'spectrim';
  model_tier: ModelTier;
  model_id: string;
  stage: SddStage;
  task_id: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  retries: number;
  review_iteration: number;
}

export interface KvCacheSegment {
  order: number;
  slot: string;
  volatility: 'static' | 'task_scoped' | 'dynamic';
  tokens: number;
  cacheHit: boolean;
  description: string;
}

export interface AbBenchmarkResult {
  config: BenchmarkConfig;
  sameModelEnforced: true;
  modelLabel: string;
  stages: StageTokenMetrics[];
  totals: {
    baselineInput: number;
    baselineCached: number;
    baselineOutput: number;
    baselineTotal: number;
    optimizedInput: number;
    optimizedCached: number;
    optimizedOutput: number;
    optimizedTotal: number;
    totalSavingsPct: number;
    inputSavingsPct: number;
    outputSavingsPct: number;
    effectiveCostSavingsPct: number; // Accounting for 90% discount on cached tokens + 3x output weight
  };
  quality: QualityParityMetrics;
  kvCacheLayout: KvCacheSegment[];
  metricsJsonl: string;
}

export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
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

export function runAbBenchmark(
  partialConfig: Partial<BenchmarkConfig> = {}
): AbBenchmarkResult {
  const cfg: BenchmarkConfig = { ...DEFAULT_BENCHMARK_CONFIG, ...partialConfig };
  const K = Math.max(4, Math.min(16, Math.round(cfg.taskCount)));
  const R_base = Math.max(2, Math.min(6, Math.round(cfg.baselineReviewIters)));
  const isSmall = cfg.modelTier === 'small';
  const modelLabel = isSmall
    ? 'Qwen2.5-Coder-32B / Llama-3.1-8B класс (одинаковая для A и B)'
    : 'Frontier Reasoning LLM (одинаковая для A и B)';

  // Small models suffer stronger Context Rot & str_replace mismatch retries in Baseline
  const baseRetryMultiplier = isSmall ? 1.32 : 1.08;
  const baseEditRetries = isSmall ? Math.round(K * 0.9) : Math.round(K * 0.3);

  // 1. Stage: spec_prep (Propose & OpenSpec sync)
  const specPrepBaseIn = 6200;
  const specPrepBaseOut = 2400;
  const specPrepOptIn = cfg.enableSpecSlicer ? 3900 : specPrepBaseIn;
  const specPrepOptOut = cfg.enableAstLodHashline ? 1750 : specPrepBaseOut;
  const specPrepOptCached = cfg.enableDeltaReviewAndCache
    ? Math.round(specPrepOptIn * 0.45)
    : 0;

  // 2. Stage: apply (Quadratic O(N^2) history tax + monolithic spec + raw test logs)
  // Baseline single-session quadratic growth: sum_{t=1..K} (T_sys + T_spec + t * T_step_hist + T_tool)
  let applyBaseIn = 0;
  let applyBaseOut = 0;
  const tSys = 1400;
  const tMonolithicSpec = 4200;
  const tRawStepHistory = 1450;
  const tRawToolNoise = 1850;
  for (let t = 1; t <= K; t++) {
    const turnsInTask = isSmall ? 3 : 2;
    for (let turn = 0; turn < turnsInTask; turn++) {
      applyBaseIn += Math.round(
        (tSys + tMonolithicSpec + t * tRawStepHistory + tRawToolNoise) *
          (turn === 0 ? 1 : 1.08)
      );
      applyBaseOut += isSmall ? 820 : 690;
    }
  }
  applyBaseIn = Math.round(applyBaseIn * baseRetryMultiplier * 0.72);
  applyBaseOut = Math.round(applyBaseOut * baseRetryMultiplier * 0.78);
  const applyBaseCached = Math.round(applyBaseIn * 0.14); // Frequent cache thrashing / compaction

  // SpecTrim apply: Fresh micro-session per task + Spec Slicer + AST-LOD + Output Compressor + Hashline
  const specFactor = cfg.enableSpecSlicer ? 0.24 : 1.0;
  const astFactor = cfg.enableAstLodHashline ? 0.34 : 1.0;
  const logFactor = cfg.enableOutputCompressor ? 0.22 : 1.0;
  const retrySavings = cfg.enableAstLodHashline && cfg.enableSpecSlicer ? 1.05 : baseRetryMultiplier;

  let applyOptIn = 0;
  let applyOptOut = 0;
  for (let t = 1; t <= K; t++) {
    const perTaskContext =
      tSys +
      Math.round(tMonolithicSpec * specFactor) +
      Math.round(2200 * astFactor) +
      Math.round(1600 * logFactor) +
      210; // State capsule
    const turns = isSmall && !cfg.enableSpecSlicer ? 3 : 2;
    applyOptIn += Math.round(perTaskContext * turns * (retrySavings > 1.1 ? 1.15 : 1.0));
    applyOptOut += Math.round(
      (cfg.enableAstLodHashline ? 390 : 710) * turns
    );
  }
  const cacheRate = cfg.enableDeltaReviewAndCache
    ? Math.max(0.2, Math.min(0.92, cfg.kvCacheHitRatePct / 100))
    : 0.12;
  const applyOptCached = Math.round(applyOptIn * cacheRate * 0.78);

  // 3. Stage: review (LLM-for-Deterministic-Checks + Full Diff Re-Read)
  const reviewPerIterBaseIn = 9600 + K * 420;
  const reviewPerIterBaseOut = 1850;
  const reviewBaseIn = reviewPerIterBaseIn * R_base;
  const reviewBaseOut = reviewPerIterBaseOut * R_base;
  const reviewBaseCached = Math.round(reviewBaseIn * 0.18);

  const R_opt = cfg.enablePreReviewGate ? 1 : Math.max(2, R_base - 1);
  const deltaFactor = cfg.enableDeltaReviewAndCache ? 0.42 : 1.0;
  const astReviewFactor = cfg.enableAstLodHashline ? 0.65 : 1.0;
  const reviewOptIn = Math.round(
    reviewPerIterBaseIn * deltaFactor * astReviewFactor * R_opt
  );
  const reviewOptOut = Math.round(
    (cfg.enableAstLodHashline ? 920 : 1650) * R_opt
  );
  const reviewOptCached = cfg.enableDeltaReviewAndCache
    ? Math.round(reviewOptIn * cacheRate * 0.85)
    : 0;

  // 4. Stage: verify (Artifact consistency & 100% REQ matrix verification)
  const verifyBaseIn = 7800 + K * 260;
  const verifyBaseOut = 1400;
  const verifyBaseCached = Math.round(verifyBaseIn * 0.15);

  const verifyOptIn = cfg.enablePreReviewGate
    ? 1450 // Deterministic matrix checked 100% by script (0 tokens); 1 tiny semantic sanity check
    : Math.round(verifyBaseIn * 0.65);
  const verifyOptOut = cfg.enablePreReviewGate ? 320 : 980;
  const verifyOptCached = cfg.enableDeltaReviewAndCache
    ? Math.round(verifyOptIn * 0.75)
    : 0;

  const mkStage = (
    stage: SddStage,
    stageLabel: string,
    bIn: number,
    bCached: number,
    bOut: number,
    oIn: number,
    oCached: number,
    oOut: number,
    rootCauseNote: string
  ): StageTokenMetrics => {
    const baselineTotal = bIn + bOut;
    const optimizedTotal = oIn + oOut;
    const savingsPct =
      baselineTotal > 0
        ? Number((((baselineTotal - optimizedTotal) / baselineTotal) * 100).toFixed(1))
        : 0;
    return {
      stage,
      stageLabel,
      baselineInput: bIn,
      baselineCached: bCached,
      baselineOutput: bOut,
      baselineTotal,
      optimizedInput: oIn,
      optimizedCached: oCached,
      optimizedOutput: oOut,
      optimizedTotal,
      savingsPct,
      rootCauseNote,
    };
  };

  const stages: StageTokenMetrics[] = [
    mkStage(
      'spec_prep',
      'Спецификация (Propose / Sync)',
      specPrepBaseIn,
      Math.round(specPrepBaseIn * 0.2),
      specPrepBaseOut,
      specPrepOptIn,
      specPrepOptCached,
      specPrepOptOut,
      'Разметка REQ/DES/TSK якорей и генерация графа трассировки'
    ),
    mkStage(
      'apply',
      'Реализация задач (Apply)',
      applyBaseIn,
      applyBaseCached,
      applyBaseOut,
      applyOptIn,
      applyOptCached,
      applyOptOut,
      'Изоляция микро-сессий + Spec Slicer + AST-LOD1 + Hashline + сжатие логов'
    ),
    mkStage(
      'review',
      'Ревью (Review Cycles)',
      reviewBaseIn,
      reviewBaseCached,
      reviewBaseOut,
      reviewOptIn,
      reviewOptCached,
      reviewOptOut,
      'Zero-Token Pre-Review Gate отсекает дефекты за 0 токенов + Delta-ревью'
    ),
    mkStage(
      'verify',
      'Верификация (Verify & Audit)',
      verifyBaseIn,
      verifyBaseCached,
      verifyBaseOut,
      verifyOptIn,
      verifyOptCached,
      verifyOptOut,
      'Матрица покрытия @spec:REQ-XX и консистентность артефактов на скрипте'
    ),
  ];

  const sum = (fn: (s: StageTokenMetrics) => number) =>
    stages.reduce((acc, s) => acc + fn(s), 0);

  const baselineInput = sum((s) => s.baselineInput);
  const baselineCached = sum((s) => s.baselineCached);
  const baselineOutput = sum((s) => s.baselineOutput);
  const baselineTotal = sum((s) => s.baselineTotal);

  const optimizedInput = sum((s) => s.optimizedInput);
  const optimizedCached = sum((s) => s.optimizedCached);
  const optimizedOutput = sum((s) => s.optimizedOutput);
  const optimizedTotal = sum((s) => s.optimizedTotal);

  const totalSavingsPct = Number(
    (((baselineTotal - optimizedTotal) / baselineTotal) * 100).toFixed(1)
  );
  const inputSavingsPct = Number(
    (((baselineInput - optimizedInput) / baselineInput) * 100).toFixed(1)
  );
  const outputSavingsPct = Number(
    (((baselineOutput - optimizedOutput) / baselineOutput) * 100).toFixed(1)
  );

  // Effective API cost weights: uncached input = 1x, cached input = 0.1x, output = 3x
  const baseCostUnits =
    (baselineInput - baselineCached) * 1 + baselineCached * 0.1 + baselineOutput * 3;
  const optCostUnits =
    (optimizedInput - optimizedCached) * 1 + optimizedCached * 0.1 + optimizedOutput * 3;
  const effectiveCostSavingsPct = Number(
    (((baseCostUnits - optCostUnits) / baseCostUnits) * 100).toFixed(1)
  );

  const quality: QualityParityMetrics = {
    baselineReqCoveragePct: isSmall ? 90 : 100,
    optimizedReqCoveragePct: 100,
    baselineTestsGreenPct: 100,
    optimizedTestsGreenPct: 100,
    baselineArtifactConsistency: true,
    optimizedArtifactConsistency: true,
    baselineFirstPassTaskRatePct: isSmall ? 58 : 79,
    optimizedFirstPassTaskRatePct: isSmall ? 92 : 97,
    baselineReviewIterations: R_base,
    optimizedReviewIterations: R_opt,
    baselineEditRetries: baseEditRetries,
    optimizedEditRetries: cfg.enableAstLodHashline ? 0 : Math.max(1, Math.floor(baseEditRetries / 2)),
  };

  const kvCacheLayout: KvCacheSegment[] = [
    {
      order: 1,
      slot: 'Системный промпт + контракты инструментов (Hashline / AST)',
      volatility: 'static',
      tokens: 1400,
      cacheHit: cfg.enableDeltaReviewAndCache,
      description: 'Неизменяемый префикс для всей сессии и между задачами — 100% KV-cache hit.',
    },
    {
      order: 2,
      slot: 'Замороженный Proposal & Glossary проекта',
      volatility: 'static',
      tokens: 480,
      cacheHit: cfg.enableDeltaReviewAndCache,
      description: 'Стабильный доменный словарь, не инвалидируется при правках кода.',
    },
    {
      order: 3,
      slot: 'Sliced Spec + Design (только для текущей задачи TSK-k)',
      volatility: 'task_scoped',
      tokens: 890,
      cacheHit: cfg.enableDeltaReviewAndCache,
      description: 'Фиксирован внутри всех шагов задачи TSK-k (чтение -> правка -> тест).',
    },
    {
      order: 4,
      slot: 'State Capsule @hash (экспортированные символы)',
      volatility: 'task_scoped',
      tokens: 210,
      cacheHit: cfg.enableDeltaReviewAndCache,
      description: 'Компактный JSON-слепок завершённых задач без истории диалога.',
    },
    {
      order: 5,
      slot: 'Динамический хвост: LOD0/LOD1 файлы + сжатый diff/лог',
      volatility: 'dynamic',
      tokens: 1180,
      cacheHit: false,
      description: 'Вынесен строго в конец промпта, чтобы не ломать префиксный кэш сегментов 1–4.',
    },
  ];

  // Generate realistic metrics.jsonl telemetry stream
  const modelId = isSmall ? 'qwen2.5-coder-32b-instruct' : 'frontier-reasoning-v1';
  const records: TelemetryEventRecord[] = [];
  const baseTs = Date.parse('2026-11-21T10:00:00.000Z');
  let offsetSec = 0;

  const pushRec = (
    run: 'baseline' | 'spectrim',
    stage: SddStage,
    taskId: string,
    input: number,
    cached: number,
    output: number,
    toolCalls: number,
    retries: number,
    reviewIter: number
  ) => {
    offsetSec += 14;
    records.push({
      ts: new Date(baseTs + offsetSec * 1000).toISOString(),
      run,
      model_tier: cfg.modelTier,
      model_id: modelId,
      stage,
      task_id: taskId,
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      tool_calls: toolCalls,
      retries,
      review_iteration: reviewIter,
    });
  };

  pushRec('baseline', 'spec_prep', 'SPEC-00', specPrepBaseIn, Math.round(specPrepBaseIn * 0.2), specPrepBaseOut, 5, 0, 0);
  for (let i = 1; i <= K; i++) {
    const tid = `TSK-${String(i).padStart(2, '0')}`;
    pushRec(
      'baseline',
      'apply',
      tid,
      Math.round(applyBaseIn / K),
      Math.round(applyBaseCached / K),
      Math.round(applyBaseOut / K),
      6,
      i <= baseEditRetries ? 1 : 0,
      0
    );
  }
  for (let r = 1; r <= R_base; r++) {
    pushRec('baseline', 'review', `REV-${r}`, reviewPerIterBaseIn, Math.round(reviewPerIterBaseIn * 0.18), reviewPerIterBaseOut, 4, 0, r);
  }
  pushRec('baseline', 'verify', 'VERIFY-ALL', verifyBaseIn, verifyBaseCached, verifyBaseOut, 4, 0, 0);

  pushRec('spectrim', 'spec_prep', 'SPEC-00', specPrepOptIn, specPrepOptCached, specPrepOptOut, 2, 0, 0);
  for (let i = 1; i <= K; i++) {
    const tid = `TSK-${String(i).padStart(2, '0')}`;
    pushRec(
      'spectrim',
      'apply',
      tid,
      Math.round(applyOptIn / K),
      Math.round(applyOptCached / K),
      Math.round(applyOptOut / K),
      3,
      0,
      0
    );
  }
  for (let r = 1; r <= R_opt; r++) {
    pushRec('spectrim', 'review', `REV-${r}`, Math.round(reviewOptIn / R_opt), Math.round(reviewOptCached / R_opt), Math.round(reviewOptOut / R_opt), 2, 0, r);
  }
  pushRec('spectrim', 'verify', 'VERIFY-ALL', verifyOptIn, verifyOptCached, verifyOptOut, 1, 0, 0);

  const metricsJsonl = records.map((r) => JSON.stringify(r)).join('\n');

  return {
    config: cfg,
    sameModelEnforced: true,
    modelLabel,
    stages,
    totals: {
      baselineInput,
      baselineCached,
      baselineOutput,
      baselineTotal,
      optimizedInput,
      optimizedCached,
      optimizedOutput,
      optimizedTotal,
      totalSavingsPct,
      inputSavingsPct,
      outputSavingsPct,
      effectiveCostSavingsPct,
    },
    quality,
    kvCacheLayout,
    metricsJsonl,
  };
}
