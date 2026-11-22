import React from 'react';
import {
  ActiveBenchmarkState,
  LiveRunProgressEvent,
  PROVENANCE_LABEL,
  SimulationConfig,
  WorkbenchStatusResponse,
} from '../types/workbench';
import { AlertTriangle, Check, GitBranch, Layers, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { LlmProviderId } from '../engine/provenance';

interface OverviewBenchmarkViewProps {
  activeData: ActiveBenchmarkState;
  viewMode: 'measured' | 'simulated';
  onChangeViewMode: (mode: 'measured' | 'simulated') => void;
  hasMeasuredRun: boolean;
  simConfig: SimulationConfig;
  onUpdateSimConfig: (patch: Partial<SimulationConfig>) => void;
  onRunServerSimulation: () => void;
  status: WorkbenchStatusResponse | null;
  statusLoading: boolean;
  selectedRepoPath: string;
  onChangeRepoPath: (repo: string) => void;
  selectedChangeId: string;
  onChangeChangeId: (changeId: string) => void;
  selectedProvider: LlmProviderId;
  onChangeProvider: (provider: LlmProviderId) => void;
  selectedModel: string;
  onChangeModel: (model: string) => void;
  onRefreshStatus: () => void;
  maxReviewIters: number;
  onChangeMaxReviewIters: (iters: number) => void;
  isRunningReal: boolean;
  onStartRealRun: () => void;
  onCancelRealRun: () => void;
  liveEvents: LiveRunProgressEvent[];
  runError: string | null;
  onLoadSavedRun: (runId: string) => void;
}

export const OverviewBenchmarkView: React.FC<OverviewBenchmarkViewProps> = ({
  activeData,
  viewMode,
  onChangeViewMode,
  hasMeasuredRun,
  simConfig,
  onUpdateSimConfig,
  onRunServerSimulation,
  status,
  statusLoading,
  selectedRepoPath,
  onChangeRepoPath,
  selectedChangeId,
  onChangeChangeId,
  selectedProvider,
  onChangeProvider,
  selectedModel,
  onChangeModel,
  onRefreshStatus,
  maxReviewIters,
  onChangeMaxReviewIters,
  isRunningReal,
  onStartRealRun,
  onCancelRealRun,
  liveEvents,
  runError,
  onLoadSavedRun,
}) => {
  const { report, kvCacheLayout } = activeData;
  const { manifest, baseline, optimized, savings, provenance, limitations } = report;

  const maxStageTokens = Math.max(
    ...baseline.stages.map((bs, idx) =>
      Math.max(bs.totalTokens, optimized.stages[idx]?.totalTokens ?? 0)
    ),
    1
  );

  const runnableRepos = (status?.repos ?? []).filter((r) => r.changes.length > 0);
  const currentRepo =
    runnableRepos.find((r) => r.repoPath === selectedRepoPath) ?? runnableRepos[0] ?? null;
  const allAvailableModels = status?.provider.availableModels ?? [];
  const modelsForSelectedProvider = allAvailableModels.filter(
    (m) => m.provider === selectedProvider
  );
  const selectedProviderReady =
    selectedProvider === 'gemini'
      ? Boolean(status?.provider.geminiConfigured)
      : selectedProvider === 'ollama'
      ? Boolean(status?.provider.ollamaConfigured)
      : Boolean(status?.provider.openAiCompatConfigured);

  const selectedProviderHint = (() => {
    if (!status) return 'Проверка окружения сервера...';
    if (selectedProvider === 'gemini') {
      return status.provider.geminiConfigured
        ? 'Облачный провайдер Gemini готов (GEMINI_API_KEY активен; флагман: gemini-4-hydrogen).'
        : 'GEMINI_API_KEY не задан на сервере. Добавьте его в .env (или Settings > Secrets) либо переключитесь на локальную Ollama без API-ключа.';
    }
    if (selectedProvider === 'ollama') {
      const ol = status.provider.ollamaStatus;
      if (ol.reachable && ol.installedModels.length > 0) {
        return `Локальная Ollama готова (${ol.baseUrl}, без API-ключа). Найдено моделей: ${ol.installedModels.length}. Стоимость в USD = n/a; API cacheUsageMeasured = false.`;
      }
      return (
        ol.error ||
        `Локальная Ollama недоступна (${ol.baseUrl}). Запустите \`ollama serve\` и скачайте модель: \`ollama pull qwen2.5-coder:7b\`.`
      );
    }
    return status.provider.openAiCompatConfigured
      ? 'OpenAI-compatible endpoint готов к работе.'
      : 'OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_API_KEY не заданы в .env.';
  })();

  const moduleToggles: Array<{
    key: keyof Pick<
      SimulationConfig,
      | 'enableSpecSlicer'
      | 'enableAstLodHashline'
      | 'enableOutputCompressor'
      | 'enablePreReviewGate'
      | 'enableDeltaReviewAndCache'
    >;
    label: string;
    effect: string;
  }> = [
    {
      key: 'enableSpecSlicer',
      label: 'Spec Slicer + микро-сессии',
      effect: 'Убирает O(N²) историю и монолитную спеку',
    },
    {
      key: 'enableAstLodHashline',
      label: 'AST-LOD1 + Hashline',
      effect: 'Скелеты смежных файлов и правки без ретраев',
    },
    {
      key: 'enableOutputCompressor',
      label: 'Output & Diff Compressor',
      effect: 'Вырезка шума тестов и дедупликация чтений',
    },
    {
      key: 'enablePreReviewGate',
      label: 'Zero-Token Pre-Review Gate',
      effect: 'Отсекает дефекты до дорогого LLM-ревью',
    },
    {
      key: 'enableDeltaReviewAndCache',
      label: 'Delta Review + KV-Cache',
      effect: 'Стабильный префикс и дифф только дельты',
    },
  ];

  const pct = (b: number, o: number) =>
    b > 0 ? Number((((b - o) / b) * 100).toFixed(1)) : 0;

  const formatDelta = (val: number | null) => {
    if (val === null) return 'n/a';
    if (val > 0) return `−${val}%`;
    if (val < 0) return `+${Math.abs(val)}%`;
    return '0%';
  };

  const deltaColor = (val: number | null) => {
    if (val === null || val === 0) return 'text-slate-600';
    return val > 0 ? 'text-emerald-700' : 'text-red-700';
  };

  return (
    <div className="space-y-8">
      {/* Intro & Mode Selector */}
      <section className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between border-b border-slate-200 pb-6">
        <div className="max-w-2xl space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>OpenCode + OpenSpec</span>
            <span aria-hidden="true">·</span>
            <span>Идентичный снимок/commit, модель и провайдер для A и B</span>
            <span aria-hidden="true">·</span>
            <span>Без model routing</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            A/B-стенд экономии токенов в Spec-Driven Development
          </h1>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            Изолированный A/B-прогон в двух <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">git worktree</code> (или идентичных <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">snapshot_copy</code> без <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">.git</code>) поверх реальных репозиториев и OpenSpec-артефактов с фиксацией <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">usageMetadata</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
          <div
            role="group"
            aria-label="Режим источника данных A/B"
            className="inline-flex w-full sm:w-auto rounded-lg bg-slate-100 p-1 border border-slate-200"
          >
            <button
              type="button"
              onClick={() => onChangeViewMode('measured')}
              disabled={!hasMeasuredRun}
              className={`flex-1 sm:flex-none px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap disabled:opacity-50 ${
                viewMode === 'measured'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Реальный A/B
            </button>
            <button
              type="button"
              onClick={() => onChangeViewMode('simulated')}
              className={`flex-1 sm:flex-none px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'simulated'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Симуляция
            </button>
          </div>
        </div>
      </section>

      {/* Honest Data Provenance Notice */}
      <section
        aria-label="Статус достоверности данных"
        className={`rounded-xl border p-4 text-xs space-y-1.5 ${
          provenance === 'measured'
            ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
            : 'bg-amber-50/70 border-amber-200 text-amber-950'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 font-semibold">
          <span>
            Достоверность активного отчёта:{' '}
            {(provenance === 'measured' || provenance === 'measured_local') && manifest.provider === 'ollama'
              ? `MEASURED_LOCAL · Локальная Ollama + ${manifest.isolationMode === 'snapshot_copy' ? 'Snapshot Copy' : 'Git Worktree'} (без API-ключа)`
              : provenance === 'measured' && manifest.isolationMode === 'snapshot_copy'
              ? 'MEASURED · API + Snapshot Copy'
              : PROVENANCE_LABEL[provenance]}
          </span>
          <span className="font-mono text-slate-700">
            provider: {manifest.provider} · runId: {manifest.runId} ·{' '}
            {manifest.isolationMode === 'snapshot_copy' ? 'snapshot' : 'commit'}:{' '}
            {(manifest.snapshotHash ?? manifest.baseCommit ?? '—').slice(0, 14)}
          </span>
        </div>
        {limitations.length > 0 && (
          <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
            {limitations.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Real Isolated Worktree / Snapshot A/B Execution Panel */}
      <section
        aria-label="Запуск реального изолированного A/B-эксперимента"
        className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
              <h2 className="text-base font-semibold text-slate-900">
                Реальный изолированный A/B-прогон ({currentRepo?.isolationCapability === 'snapshot_copy' ? 'snapshot copy' : 'git worktree'})
              </h2>
            </div>
            <p className="text-xs text-slate-600">
              {currentRepo?.isolationCapability === 'snapshot_copy'
                ? 'В текущем контейнере нет .git — создаёт две идентичные изолированные копии снимка (SHA-256), прогоняет Baseline и SpecTrim на одной модели, запускает реальные тесты и сохраняет metrics.jsonl + diff в .spectrim-runs/.'
                : 'Создаёт два отдельных worktree от одного commit SHA, прогоняет Baseline и SpecTrim на одной модели, запускает реальные тесты и сохраняет metrics.jsonl + diff в .spectrim-runs/.'}
            </p>
          </div>

          {status && status.savedRuns.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 min-w-0 w-full md:w-auto">
              <label htmlFor="saved-run-select" className="text-xs font-medium text-slate-600 shrink-0">
                Сохранённые прогоны:
              </label>
              <select
                id="saved-run-select"
                value={viewMode === 'measured' ? manifest.runId : ''}
                onChange={(e) => {
                  if (e.target.value) void onLoadSavedRun(e.target.value);
                }}
                className="w-full md:w-auto max-w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-mono text-slate-900"
              >
                <option value="">Выберите прогон...</option>
                {status.savedRuns.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.runId} ({r.repoName} / {r.totalSavingsPct ?? 0}%)
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
          <div className="lg:col-span-2">
            <label htmlFor="ab-repo" className="block text-xs font-medium text-slate-700 mb-1">
              Репозиторий полигона
            </label>
            <select
              id="ab-repo"
              value={selectedRepoPath}
              onChange={(e) => onChangeRepoPath(e.target.value)}
              disabled={statusLoading || isRunningReal}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              {runnableRepos.length === 0 ? (
                <option value="benchmarks/orders-ts">benchmarks/orders-ts</option>
              ) : (
                runnableRepos.map((r) => (
                  <option key={r.repoPath} value={r.repoPath}>
                    {r.repoPath} ({r.language} · {r.isolationCapability === 'git_worktree' ? 'git' : 'snapshot'})
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="ab-change" className="block text-xs font-medium text-slate-700 mb-1">
              OpenSpec Change
            </label>
            <select
              id="ab-change"
              value={selectedChangeId}
              onChange={(e) => onChangeChangeId(e.target.value)}
              disabled={statusLoading || isRunningReal}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              {(currentRepo?.changes ?? ['add-idempotency-and-webhooks', 'add-rate-limit-and-audit']).map(
                (ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                )
              )}
            </select>
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="ab-reviews" className="block text-xs font-medium text-slate-700 mb-1">
              Итераций ревью (Baseline)
            </label>
            <select
              id="ab-reviews"
              value={maxReviewIters}
              onChange={(e) => onChangeMaxReviewIters(Number(e.target.value))}
              disabled={isRunningReal}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'итерация' : n < 5 ? 'итерации' : 'итераций'}
                </option>
              ))}
            </select>
          </div>

          <div className="lg:col-span-3">
            <label htmlFor="ab-provider" className="block text-xs font-medium text-slate-700 mb-1">
              Провайдер (A и B)
            </label>
            <select
              id="ab-provider"
              value={selectedProvider}
              onChange={(e) => onChangeProvider(e.target.value as LlmProviderId)}
              disabled={statusLoading || isRunningReal}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              <option value="gemini">
                gemini ({status?.provider.geminiConfigured ? 'готов · облачный флагман' : 'нет ключа'})
              </option>
              <option value="ollama">
                ollama ({status?.provider.ollamaConfigured ? 'готов · локально без ключа' : 'локально без API-ключа'})
              </option>
              <option value="openai_compat">
                openai_compat ({status?.provider.openAiCompatConfigured ? 'готов' : 'не задан'})
              </option>
            </select>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <label htmlFor="ab-model" className="block text-xs font-medium text-slate-700 mb-1">
              Единая модель (A и B)
            </label>
            <select
              id="ab-model"
              value={selectedModel}
              onChange={(e) => onChangeModel(e.target.value)}
              disabled={!selectedProviderReady || isRunningReal}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900 disabled:bg-slate-100 disabled:text-slate-500"
            >
              {selectedProviderReady ? (
                modelsForSelectedProvider.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))
              ) : selectedProvider === 'gemini' ? (
                <option value="gemini-4-hydrogen">Требуется GEMINI_API_KEY</option>
              ) : selectedProvider === 'ollama' ? (
                <option value={selectedModel || 'qwen2.5-coder:7b'}>
                  {status?.provider.ollamaStatus.reachable
                    ? 'Нет скачанных моделей (ollama pull)'
                    : 'Ollama не запущена (ollama serve)'}
                </option>
              ) : (
                <option value="">Не настроен OPENAI_COMPAT_*</option>
              )}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs text-slate-600 max-w-2xl">
            {selectedProviderHint}
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onRefreshStatus}
              disabled={isRunningReal}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-60 text-slate-700 text-xs font-medium transition-colors whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Обновить статус
            </button>
            {isRunningReal && (
              <button
                type="button"
                onClick={onCancelRealRun}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-800 text-xs font-medium transition-colors whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
                Отменить прогон
              </button>
            )}
            <button
              type="button"
              onClick={onStartRealRun}
              disabled={isRunningReal}
              className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-medium transition-colors whitespace-nowrap"
            >
              {isRunningReal ? 'Идёт worktree A/B прогон...' : 'Запустить реальный worktree A/B'}
            </button>
          </div>
        </div>

        {runError && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs text-red-900 flex items-start gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" aria-hidden="true" />
            <span>{runError}</span>
          </div>
        )}

        {liveEvents.length > 0 && (
          <div className="bg-slate-900 text-slate-100 rounded-lg p-3.5 text-xs font-mono space-y-1 max-h-44 overflow-y-auto">
            {liveEvents.map((ev, idx) => (
              <div key={idx}>
                <span className="text-slate-400">[{ev.phase}]</span> {ev.message}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 4-Column KPI Summary Strip */}
      <section
        aria-label="Ключевые показатели A/B сравнения"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Общий расход токенов</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className={`text-2xl font-bold tabular-nums ${savings.totalTokensPct !== null && savings.totalTokensPct < 0 ? 'text-red-700' : 'text-slate-900'}`}>
              {formatDelta(savings.totalTokensPct)}
            </span>
            <span className={`text-xs font-semibold tabular-nums ${deltaColor(savings.totalTokensPct)}`}>
              {optimized.totalTokens.toLocaleString('ru-RU')} ток.
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Baseline: {baseline.totalTokens.toLocaleString('ru-RU')} токенов
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Стоимость и Cached Input</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              {formatDelta(savings.costPct)}
            </span>
            <span className={`text-xs font-medium tabular-nums ${deltaColor(savings.completionTokensPct)}`}>
              Out: {formatDelta(savings.completionTokensPct)}
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Cached: {optimized.cachedInputTokens.toLocaleString('ru-RU')} ·{' '}
            {optimized.costUsd !== null ? `$${optimized.costUsd.toFixed(4)}` : 'тариф n/a'}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Итерации ревью и tool calls</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              {baseline.reviewIterations} → {optimized.reviewIterations}
            </span>
            <span className="text-xs font-medium text-blue-700 tabular-nums">
              Gate: 0 ток.
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Tools: {baseline.toolCalls} → {optimized.toolCalls} · Retries: {baseline.retries} →{' '}
            {optimized.retries}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Контроль качества (Parity)</div>
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`text-2xl font-bold tabular-nums ${
                optimized.reqCoveragePct === 100 ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {optimized.reqCoveragePct}% REQ
            </span>
            {optimized.testsPassed ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                Тесты PASS
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                Тесты FAIL
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Задачи: {optimized.tasksCompleted}/{optimized.tasksTotal} · Lint:{' '}
            <span className={optimized.lintPassed ? 'text-emerald-700 font-semibold' : 'text-red-700 font-semibold'}>
              {optimized.lintPassed ? 'PASS' : 'FAIL'}
            </span>
          </div>
        </div>
      </section>

      {/* Main Split: Stage Chart & Simulation / Run Controls */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 flex flex-col space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Расход токенов по стадиям SDD (Baseline vs SpecTrim)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 font-mono">
                {manifest.provider} · {manifest.model} · {manifest.repoName} / {manifest.changeId}
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-slate-600 shrink-0">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-slate-400 inline-block" aria-hidden="true" />
                Baseline
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-xs bg-blue-600 inline-block" aria-hidden="true" />
                SpecTrim
              </span>
            </div>
          </div>

          <div className="space-y-5" data-testid="stage-chart">
            {baseline.stages.map((bs, idx) => {
              const os = optimized.stages[idx];
              if (!os) return null;
              const basePct = Math.max(4, (bs.totalTokens / maxStageTokens) * 100);
              const optPct = Math.max(2, (os.totalTokens / maxStageTokens) * 100);
              const stageSaving = pct(bs.totalTokens, os.totalTokens);
              return (
                <div key={bs.stage} className="space-y-2">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-medium text-slate-800">{bs.stageLabel}</span>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      <span className="text-slate-500">
                        {bs.totalTokens.toLocaleString('ru-RU')} →{' '}
                        <strong className="text-slate-900">
                          {os.totalTokens.toLocaleString('ru-RU')}
                        </strong>
                      </span>
                      <span className={`font-semibold min-w-[3.5rem] text-right ${deltaColor(stageSaving)}`}>
                        {formatDelta(stageSaving)}
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="w-full bg-slate-100 rounded-sm h-2.5 overflow-hidden">
                      <div
                        className="bg-slate-400 h-full rounded-sm transition-all duration-200"
                        style={{ width: `${basePct}%` }}
                      />
                    </div>
                    <div className="w-full bg-slate-100 rounded-sm h-2.5 overflow-hidden">
                      <div
                        className="bg-blue-600 h-full rounded-sm transition-all duration-200"
                        style={{ width: `${optPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-auto border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-slate-800">Проверка качества на worktree</div>
              <div className="font-mono text-slate-600 leading-relaxed">
                Test: {manifest.testCommand}
                <br />
                Lint: {manifest.lintCommand}
              </div>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-slate-800">Почему SpecTrim побеждает без смены LLM</div>
              <div className="text-slate-600 leading-relaxed">
                Изоляция микро-сессий, Hashline range-патчи, AST-LOD1 и Pre-Review Gate переводят рост контекста из O(N²) в O(N).
              </div>
            </div>
          </div>
        </div>

        {/* Right 4 cols: Simulation Ablation Controls OR Real Run Parity Details */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          {viewMode === 'simulated' ? (
            <>
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Параметры мат. симуляции
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Ablation Study (provenance: simulated)
                </p>
              </div>

              <div className="space-y-4">
                <div className="inline-flex w-full rounded-lg bg-slate-100 p-1 border border-slate-200">
                  <button
                    type="button"
                    onClick={() => onUpdateSimConfig({ modelTier: 'small' })}
                    className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      simConfig.modelTier === 'small'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Малая LLM
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateSimConfig({ modelTier: 'large' })}
                    className={`flex-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      simConfig.modelTier === 'large'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Большая LLM
                  </button>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                    <label htmlFor="slider-tasks">Задач в фиче (K)</label>
                    <span className="font-mono tabular-nums text-slate-900">
                      {simConfig.taskCount}
                    </span>
                  </div>
                  <input
                    id="slider-tasks"
                    type="range"
                    min={6}
                    max={16}
                    value={simConfig.taskCount}
                    onChange={(e) => onUpdateSimConfig({ taskCount: Number(e.target.value) })}
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                    <label htmlFor="slider-reviews">Итераций ревью (R)</label>
                    <span className="font-mono tabular-nums text-slate-900">
                      {simConfig.baselineReviewIters}
                    </span>
                  </div>
                  <input
                    id="slider-reviews"
                    type="range"
                    min={2}
                    max={6}
                    value={simConfig.baselineReviewIters}
                    onChange={(e) =>
                      onUpdateSimConfig({ baselineReviewIters: Number(e.target.value) })
                    }
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                    <label htmlFor="slider-cache">Ожидаемый KV-Cache Hit</label>
                    <span className="font-mono tabular-nums text-slate-900">
                      {simConfig.kvCacheHitRatePct}%
                    </span>
                  </div>
                  <input
                    id="slider-cache"
                    type="range"
                    min={30}
                    max={92}
                    value={simConfig.kvCacheHitRatePct}
                    onChange={(e) =>
                      onUpdateSimConfig({ kvCacheHitRatePct: Number(e.target.value) })
                    }
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 space-y-2">
                <div className="text-xs font-semibold text-slate-700">Модули SpecTrim</div>
                {moduleToggles.map((mod) => {
                  const checked = simConfig[mod.key];
                  return (
                    <label
                      key={mod.key}
                      className="flex items-start gap-2.5 cursor-pointer py-1 rounded-md hover:bg-slate-50 px-1.5 -mx-1.5"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onUpdateSimConfig({ [mod.key]: e.target.checked })}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                      />
                      <span className="text-xs leading-snug">
                        <span className="font-medium text-slate-800 block">{mod.label}</span>
                        <span className="text-slate-500">{mod.effect}</span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={onRunServerSimulation}
                className="w-full py-2 px-4 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium transition-colors whitespace-nowrap"
              >
                Пересчитать модель (simulated)
              </button>
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">Run Manifest & Parity</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Подтверждение идентичности условий A/B
                </p>
              </div>
              <dl className="divide-y divide-slate-100 text-xs">
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">Изоляция A/B</dt>
                  <dd className="font-mono text-slate-900">
                    {manifest.isolationMode === 'snapshot_copy' ? 'snapshot_copy' : 'git_worktree'}
                    {manifest.repoSubpath ? ` (${manifest.repoSubpath})` : ''}
                  </dd>
                </div>
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">
                    {manifest.isolationMode === 'snapshot_copy' ? 'Snapshot SHA-256' : 'Base Commit'}
                  </dt>
                  <dd className="font-mono text-slate-900">
                    {(manifest.snapshotHash ?? manifest.baseCommit ?? '—').slice(0, 14)}
                  </dd>
                </div>
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">Провайдер / Модель</dt>
                  <dd className="font-mono text-slate-900">
                    {manifest.provider} / {manifest.model}
                  </dd>
                </div>
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">Changed files (B)</dt>
                  <dd className="font-mono text-slate-900">{optimized.changedFiles.length}</dd>
                </div>
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">Diff lines (A vs B)</dt>
                  <dd className="font-mono text-slate-900">
                    {baseline.diffLineCount} vs {optimized.diffLineCount}
                  </dd>
                </div>
                <div className="py-2 flex justify-between gap-2">
                  <dt className="text-slate-500">Artifact consistency</dt>
                  <dd
                    className={`font-mono font-semibold ${
                      optimized.artifactConsistency ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {optimized.artifactConsistency ? 'PASS' : 'FAIL'}
                  </dd>
                </div>
              </dl>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-700">Сводка тестов SpecTrim:</div>
                <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                  {optimized.testsOutputSummary}
                </pre>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Detailed Stage Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Детализация токенов: Prompt / Cached / Completion по стадиям
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            Prompt {formatDelta(savings.promptTokensPct)} ·
            Cached: {optimized.cachedInputTokens.toLocaleString('ru-RU')} · Completion{' '}
            {formatDelta(savings.completionTokensPct)}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-3 px-4">Стадия SDD</th>
                <th className="py-3 px-4 text-right">Baseline Prompt</th>
                <th className="py-3 px-4 text-right">Baseline Out</th>
                <th className="py-3 px-4 text-right">Baseline Итого</th>
                <th className="py-3 px-4 text-right">SpecTrim Prompt</th>
                <th className="py-3 px-4 text-right">Cached</th>
                <th className="py-3 px-4 text-right">SpecTrim Out</th>
                <th className="py-3 px-4 text-right">SpecTrim Итого</th>
                <th className="py-3 px-4 text-right">Экономия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {baseline.stages.map((bs, idx) => {
                const os = optimized.stages[idx];
                if (!os) return null;
                const stageSaving = pct(bs.totalTokens, os.totalTokens);
                return (
                  <tr key={bs.stage} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4 font-medium text-slate-900">{bs.stageLabel}</td>
                    <td className="py-3 px-4 text-right text-slate-600 font-mono text-xs">
                      {bs.promptTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-600 font-mono text-xs">
                      {bs.completionTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-800 font-mono text-xs font-semibold">
                      {bs.totalTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-700 font-mono text-xs">
                      {os.promptTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-blue-700 font-mono text-xs">
                      {os.cachedInputTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-700 font-mono text-xs">
                      {os.completionTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className="py-3 px-4 text-right text-slate-900 font-mono text-xs font-semibold">
                      {os.totalTokens.toLocaleString('ru-RU')}
                    </td>
                    <td className={`py-3 px-4 text-right font-mono text-xs font-semibold ${deltaColor(stageSaving)}`}>
                      {formatDelta(stageSaving)}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50 font-semibold border-t border-slate-200">
                <td className="py-3 px-4 text-slate-900">ИТОГО за фичу</td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700">
                  {baseline.promptTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700">
                  {baseline.completionTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-900">
                  {baseline.totalTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-800">
                  {optimized.promptTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-blue-700">
                  {optimized.cachedInputTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-800">
                  {optimized.completionTokens.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-900">
                  {optimized.totalTokens.toLocaleString('ru-RU')}
                </td>
                <td className={`py-3 px-4 text-right font-mono text-xs ${deltaColor(savings.totalTokensPct)}`}>
                  {formatDelta(savings.totalTokensPct)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Cache-Aware Prompt Layout */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600 shrink-0" aria-hidden="true" />
            <h2 className="text-base font-semibold text-slate-900">
              Cache-Aware порядок секций промпта (KV-Cache Prefix Layout)
            </h2>
          </div>
          <span className="text-xs text-slate-500">
            Динамический хвост вынесен в конец — префиксные 1–4 слоты стабильны
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {kvCacheLayout.map((seg) => (
            <div
              key={seg.order}
              className={`border rounded-lg p-3.5 space-y-1.5 ${
                seg.cacheHit
                  ? 'border-blue-200 bg-blue-50/40'
                  : 'border-slate-200 bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-500">Слот {seg.order}</span>
                <span className="font-semibold text-slate-900 tabular-nums">{seg.tokens} ток.</span>
              </div>
              <div className="text-xs font-semibold text-slate-900 leading-snug">{seg.slot}</div>
              <p className="text-xs text-slate-600 leading-relaxed">{seg.description}</p>
              <div className="pt-1 flex items-center gap-1 text-xs font-medium">
                {seg.cacheHit ? (
                  <span className="inline-flex items-center gap-1 text-blue-700">
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    KV-Cache Hit
                  </span>
                ) : (
                  <span className="text-slate-500">Динамический хвост</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
