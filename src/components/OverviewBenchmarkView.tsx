import React from 'react';
import { AbBenchmarkResult, BenchmarkConfig } from '../engine/abBenchmark';
import { Check, Layers, ShieldCheck } from 'lucide-react';

interface OverviewBenchmarkViewProps {
  benchmark: AbBenchmarkResult;
  config: BenchmarkConfig;
  onUpdateConfig: (patch: Partial<BenchmarkConfig>) => void;
  onRunBenchmark: () => void;
  isRunning: boolean;
}

export const OverviewBenchmarkView: React.FC<OverviewBenchmarkViewProps> = ({
  benchmark,
  config,
  onUpdateConfig,
  onRunBenchmark,
  isRunning,
}) => {
  const { totals, stages, quality, kvCacheLayout } = benchmark;
  const maxStageTokens = Math.max(
    ...stages.map((s) => Math.max(s.baselineTotal, s.optimizedTotal)),
    1
  );

  const moduleToggles: Array<{
    key: keyof Pick<
      BenchmarkConfig,
      | 'enableSpecSlicer'
      | 'enableAstLodHashline'
      | 'enableOutputCompressor'
      | 'enablePreReviewGate'
      | 'enableDeltaReviewAndCache'
    >;
    label: string;
    effect: string;
  }> = [
    { key: 'enableSpecSlicer', label: 'Spec Slicer + микро-сессии', effect: 'Убирает O(N²) историю и монолитную спеку' },
    { key: 'enableAstLodHashline', label: 'AST-LOD1 + Hashline', effect: 'Скелеты смежных файлов и правки без ретраев' },
    { key: 'enableOutputCompressor', label: 'Output & Diff Compressor', effect: 'Вырезка шума тестов и дедупликация чтений' },
    { key: 'enablePreReviewGate', label: 'Zero-Token Pre-Review Gate', effect: 'Отсекает дефекты до дорогого LLM-ревью' },
    { key: 'enableDeltaReviewAndCache', label: 'Delta Review + KV-Cache', effect: 'Стабильный префикс и дифф только дельты' },
  ];

  return (
    <div className="space-y-8">
      {/* Intro & Simulation Control Strip */}
      <section className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between border-b border-slate-200 pb-6">
        <div className="max-w-2xl space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>OpenCode + OpenSpec</span>
            <span aria-hidden="true">·</span>
            <span>Одинаковая модель для A и B</span>
            <span aria-hidden="true">·</span>
            <span>Без model routing</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 [text-wrap:balance]">
            A/B-стенд экономии токенов в Spec-Driven Development
          </h1>
          <p className="text-sm sm:text-base text-slate-600 leading-relaxed">
            Сравнение стандартного монолитного пайплайна (Baseline) и 5-модульной архитектуры SpecTrim
            на brownfield-фиче ({config.taskCount} задач, требования REQ-01..REQ-{String(config.taskCount).padStart(2, '0')}).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div
            role="group"
            aria-label="Выбор класса модели"
            className="inline-flex rounded-lg bg-slate-100 p-1 border border-slate-200"
          >
            <button
              type="button"
              onClick={() => onUpdateConfig({ modelTier: 'small' })}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                config.modelTier === 'small'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Малая LLM (8B–32B)
            </button>
            <button
              type="button"
              onClick={() => onUpdateConfig({ modelTier: 'large' })}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                config.modelTier === 'large'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Большая LLM (Frontier)
            </button>
          </div>
        </div>
      </section>

      {/* 4-Column KPI Summary Strip */}
      <section
        aria-label="Ключевые показатели A/B сравнения"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Общий расход токенов</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              −{totals.totalSavingsPct}%
            </span>
            <span className="text-xs font-semibold text-emerald-700 tabular-nums">
              {totals.optimizedTotal.toLocaleString('ru-RU')} ток.
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Baseline: {totals.baselineTotal.toLocaleString('ru-RU')} токенов
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Эффективная стоимость API</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              −{totals.effectiveCostSavingsPct}%
            </span>
            <span className="text-xs font-medium text-slate-600 tabular-nums">
              Out: −{totals.outputSavingsPct}%
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            С учётом KV-cache ({config.kvCacheHitRatePct}%) и веса output 3x
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Итерации LLM-ревью</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-slate-900 tabular-nums">
              {quality.baselineReviewIterations} → {quality.optimizedReviewIterations}
            </span>
            <span className="text-xs font-medium text-blue-700 tabular-nums">
              Gate: 0 ток.
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            Ретраи правок: {quality.baselineEditRetries} → {quality.optimizedEditRetries}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
          <div className="text-xs font-medium text-slate-500">Контроль качества (Parity)</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-2xl font-bold text-emerald-700 tabular-nums">
              {quality.optimizedReqCoveragePct}% REQ
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {quality.optimizedTestsGreenPct}% тесты
            </span>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            First-pass: {quality.baselineFirstPassTaskRatePct}% → {quality.optimizedFirstPassTaskRatePct}%
          </div>
        </div>
      </section>

      {/* Main Split: Stage Chart & Interactive Parameters */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left 8 cols: Stage-by-stage SVG Visualization */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 flex flex-col space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Расход токенов по стадиям SDD (Baseline vs SpecTrim)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {benchmark.modelLabel}
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

          {/* Crisp Horizontal Grouped Bar Chart */}
          <div className="space-y-5" data-testid="stage-chart">
            {stages.map((s) => {
              const basePct = Math.max(4, (s.baselineTotal / maxStageTokens) * 100);
              const optPct = Math.max(2, (s.optimizedTotal / maxStageTokens) * 100);
              return (
                <div key={s.stage} className="space-y-2">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-medium text-slate-800">{s.stageLabel}</span>
                    <div className="flex items-center gap-3 text-xs tabular-nums">
                      <span className="text-slate-500">
                        {s.baselineTotal.toLocaleString('ru-RU')} →{' '}
                        <strong className="text-slate-900">
                          {s.optimizedTotal.toLocaleString('ru-RU')}
                        </strong>
                      </span>
                      <span className="font-semibold text-emerald-700 min-w-[3.5rem] text-right">
                        −{s.savingsPct}%
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
                  <p className="text-xs text-slate-500">{s.rootCauseNote}</p>
                </div>
              );
            })}
          </div>

          {/* Mathematical Model & Root-Cause Summary */}
          <div className="mt-auto border-t border-slate-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-slate-800">Формула утечек в Baseline (O(N²))</div>
              <div className="font-mono text-slate-600 leading-relaxed">
                T_total = Σ(T_sys + T_spec + T_history(t) + T_tool(t)) + ΣT_out
              </div>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
              <div className="font-semibold text-slate-800">Почему SpecTrim побеждает без смены LLM</div>
              <div className="text-slate-600 leading-relaxed">
                Apply + Review сжигают &gt;85% бюджета Baseline. Изоляция сессий и Pre-Review Gate (0 ток.) переводят рост из O(N²) в O(N).
              </div>
            </div>
          </div>
        </div>

        {/* Right 4 cols: Interactive Benchmark Controls & Ablation Toggles */}
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Параметры эксперимента</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Проверка вклада каждого модуля (Ablation Study)
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                <label htmlFor="slider-tasks">Количество задач в фиче (K)</label>
                <span className="font-mono tabular-nums text-slate-900">{config.taskCount}</span>
              </div>
              <input
                id="slider-tasks"
                type="range"
                min={6}
                max={16}
                value={config.taskCount}
                onChange={(e) => onUpdateConfig({ taskCount: Number(e.target.value) })}
                className="w-full accent-blue-600 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                <label htmlFor="slider-reviews">Итерации ревью в Baseline (R)</label>
                <span className="font-mono tabular-nums text-slate-900">{config.baselineReviewIters}</span>
              </div>
              <input
                id="slider-reviews"
                type="range"
                min={2}
                max={6}
                value={config.baselineReviewIters}
                onChange={(e) => onUpdateConfig({ baselineReviewIters: Number(e.target.value) })}
                className="w-full accent-blue-600 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs font-medium text-slate-700 mb-1.5">
                <label htmlFor="slider-cache">Prefix KV-Cache Hit Rate</label>
                <span className="font-mono tabular-nums text-slate-900">{config.kvCacheHitRatePct}%</span>
              </div>
              <input
                id="slider-cache"
                type="range"
                min={30}
                max={92}
                value={config.kvCacheHitRatePct}
                onChange={(e) => onUpdateConfig({ kvCacheHitRatePct: Number(e.target.value) })}
                className="w-full accent-blue-600 cursor-pointer"
              />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 space-y-2.5">
            <div className="text-xs font-semibold text-slate-700">Активные модули SpecTrim</div>
            {moduleToggles.map((mod) => {
              const checked = config[mod.key];
              return (
                <label
                  key={mod.key}
                  className="flex items-start gap-2.5 cursor-pointer py-1 rounded-md hover:bg-slate-50 px-1.5 -mx-1.5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onUpdateConfig({ [mod.key]: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
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
            onClick={onRunBenchmark}
            disabled={isRunning}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium transition-colors whitespace-nowrap"
          >
            {isRunning ? 'Пересчёт телеметрии...' : 'Пересчитать A/B через сервер'}
          </button>
        </div>
      </section>

      {/* Detailed Stage Table + Input/Cached/Output Breakdown */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            Детализация токенов: Input / Cached / Output по стадиям
          </h2>
          <span className="text-xs text-slate-500 tabular-nums">
            Input −{totals.inputSavingsPct}% · Cached hit: {totals.optimizedCached.toLocaleString('ru-RU')} ток. · Output −{totals.outputSavingsPct}%
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-3 px-4">Стадия SDD</th>
                <th className="py-3 px-4 text-right">Baseline In</th>
                <th className="py-3 px-4 text-right">Baseline Out</th>
                <th className="py-3 px-4 text-right">Baseline Итого</th>
                <th className="py-3 px-4 text-right">SpecTrim In</th>
                <th className="py-3 px-4 text-right">Из них Cached</th>
                <th className="py-3 px-4 text-right">SpecTrim Out</th>
                <th className="py-3 px-4 text-right">SpecTrim Итого</th>
                <th className="py-3 px-4 text-right">Экономия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums">
              {stages.map((s) => (
                <tr key={s.stage} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3 px-4 font-medium text-slate-900">{s.stageLabel}</td>
                  <td className="py-3 px-4 text-right text-slate-600 font-mono text-xs">
                    {s.baselineInput.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-600 font-mono text-xs">
                    {s.baselineOutput.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-800 font-mono text-xs font-semibold">
                    {s.baselineTotal.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-700 font-mono text-xs">
                    {s.optimizedInput.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-blue-700 font-mono text-xs">
                    {s.optimizedCached.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-700 font-mono text-xs">
                    {s.optimizedOutput.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-900 font-mono text-xs font-semibold">
                    {s.optimizedTotal.toLocaleString('ru-RU')}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-xs font-semibold text-emerald-700">
                    −{s.savingsPct}%
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold border-t border-slate-200">
                <td className="py-3 px-4 text-slate-900">ИТОГО за фичу</td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700">
                  {totals.baselineInput.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-700">
                  {totals.baselineOutput.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-900">
                  {totals.baselineTotal.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-800">
                  {totals.optimizedInput.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-blue-700">
                  {totals.optimizedCached.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-800">
                  {totals.optimizedOutput.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-slate-900">
                  {totals.optimizedTotal.toLocaleString('ru-RU')}
                </td>
                <td className="py-3 px-4 text-right font-mono text-xs text-emerald-700">
                  −{totals.totalSavingsPct}%
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
            Динамический хвост вынесен в конец — префиксные 1–4 слоты не инвалидируются
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
