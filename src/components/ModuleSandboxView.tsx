import React, { useState, useMemo } from 'react';
import {
  DEMO_GATE_FILES,
  DEMO_KNOWN_CONTRACTS,
  DEMO_OPENSPEC_BUNDLE,
  DEMO_RAW_GIT_DIFF,
  DEMO_RAW_PYTEST_LOG,
  DEMO_SAMPLE_PYTHON_FILE,
} from '../data/demoWorkspace';
import { parseOpenSpecBundle, sliceSpecForTask } from '../engine/specSlicer';
import {
  applyHashlinePatch,
  formatWithHashlines,
  LodLevel,
  renderAstLodView,
} from '../engine/astLodHashline';
import {
  compressGitDiff,
  compressTestLog,
  deduplicateFileReads,
} from '../engine/outputCompressor';
import { runPreReviewGate } from '../engine/preReviewGate';
import { Check, AlertTriangle, Scissors, FileCode2, Terminal, ShieldAlert } from 'lucide-react';

type SandboxTab = 'slicer' | 'ast_hashline' | 'compressor' | 'gate';

export const ModuleSandboxView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SandboxTab>('slicer');

  // 1. Spec Slicer state
  const graph = useMemo(() => parseOpenSpecBundle(DEMO_OPENSPEC_BUNDLE), []);
  const [selectedTaskId, setSelectedTaskId] = useState<string>('TSK-07');
  const completedUpToTask = useMemo(() => {
    const idx = graph.tasks.findIndex((t) => t.id === selectedTaskId);
    return graph.tasks.slice(0, Math.max(0, idx)).map((t) => t.id);
  }, [graph.tasks, selectedTaskId]);

  const sliceResult = useMemo(
    () =>
      sliceSpecForTask(
        DEMO_OPENSPEC_BUNDLE,
        selectedTaskId,
        completedUpToTask,
        DEMO_KNOWN_CONTRACTS
      ),
    [selectedTaskId, completedUpToTask]
  );

  // 2. AST-LOD & Hashline state
  const [lodLevel, setLodLevel] = useState<LodLevel>('LOD1');
  const [sourceCode, setSourceCode] = useState<string>(DEMO_SAMPLE_PYTHON_FILE);
  const hashedSource = useMemo(() => formatWithHashlines(sourceCode), [sourceCode]);
  const astView = useMemo(
    () =>
      renderAstLodView(
        'src/middleware/rate_limiter.py',
        sourceCode,
        'python',
        lodLevel,
        [
          'src/middleware/rate_limiter.py',
          'src/audit/audit_logger.py',
          'src/api/orders_router.py',
          'src/api/audit_router.py',
          'tests/test_rate_limit_audit.py',
        ]
      ),
    [sourceCode, lodLevel]
  );

  // Target line 6 (BYPASS_PATHS) for live Hashline patch demonstration
  const defaultPatchLine = hashedSource.lines[5] ?? hashedSource.lines[0];
  const [patchHashOverride, setPatchHashOverride] = useState<string>('');
  const [patchReplacement, setPatchReplacement] = useState<string>(
    'BYPASS_PATHS = {"/healthz", "/metrics", "/readyz"}'
  );
  const [lastPatchResult, setLastPatchResult] = useState<ReturnType<typeof applyHashlinePatch> | null>(
    null
  );

  const handleApplyHashlinePatch = (useStaleHash: boolean) => {
    const targetLine = hashedSource.lines[5] ?? hashedSource.lines[0];
    const hashToUse = useStaleHash
      ? '000'
      : patchHashOverride || targetLine.hash;
    const res = applyHashlinePatch(sourceCode, {
      startLine: targetLine.lineNumber,
      startHash: hashToUse,
      endLine: targetLine.lineNumber,
      endHash: hashToUse,
      replacement: patchReplacement,
    });
    setLastPatchResult(res);
    if (res.ok) {
      setSourceCode(res.updatedContent);
    }
  };

  // 3. Log & Diff Compressor state
  const [compressorMode, setCompressorMode] = useState<'pytest' | 'diff' | 'dedup'>('pytest');
  const compressedPytest = useMemo(
    () => compressTestLog(DEMO_RAW_PYTEST_LOG, 'pytest'),
    []
  );
  const compressedDiff = useMemo(
    () => compressGitDiff(DEMO_RAW_GIT_DIFF, { 'src/api/orders_router.py': '552a99c' }),
    []
  );
  const dedupResult = useMemo(
    () =>
      deduplicateFileReads([
        { step: 1, path: 'src/middleware/rate_limiter.py', content: DEMO_SAMPLE_PYTHON_FILE },
        { step: 3, path: 'src/middleware/rate_limiter.py', content: DEMO_SAMPLE_PYTHON_FILE },
        { step: 6, path: 'src/middleware/rate_limiter.py', content: DEMO_SAMPLE_PYTHON_FILE },
        { step: 9, path: 'src/middleware/rate_limiter.py', content: DEMO_SAMPLE_PYTHON_FILE },
      ]),
    []
  );

  // 4. Zero-Token Pre-Review Gate state
  const [defectMissingReqTest, setDefectMissingReqTest] = useState<boolean>(false);
  const [defectUncheckedTask, setDefectUncheckedTask] = useState<boolean>(false);
  const [defectFailingTest, setDefectFailingTest] = useState<boolean>(false);
  const [defectLintError, setDefectLintError] = useState<boolean>(false);
  const [defectBrokenDesign, setDefectBrokenDesign] = useState<boolean>(false);

  const gateResult = useMemo(() => {
    let bundle = { ...DEMO_OPENSPEC_BUNDLE };
    if (defectUncheckedTask) {
      bundle = {
        ...bundle,
        tasksMd: bundle.tasksMd.replace('- [x] [TSK-07]', '- [ ] [TSK-07]'),
      };
    }
    if (defectBrokenDesign) {
      bundle = {
        ...bundle,
        designMd: bundle.designMd.replace(
          'Linked requirements: REQ-09',
          'Linked requirements: REQ-99'
        ),
      };
    }
    const files = DEMO_GATE_FILES.map((f) =>
      defectMissingReqTest && f.isTest
        ? { ...f, content: f.content.replace('@spec:REQ-07', '') }
        : f
    );

    return runPreReviewGate({
      bundle,
      files,
      testsPassing: !defectFailingTest,
      failingTestSnippet: defectFailingTest
        ? 'FAILED tests/test_rate_limit_audit.py::test_spool_fallback_on_sink_error - AssertionError'
        : undefined,
      lintErrors: defectLintError
        ? ['src/audit/audit_logger.py:42:5 F401 unused import json']
        : [],
    });
  }, [
    defectMissingReqTest,
    defectUncheckedTask,
    defectFailingTest,
    defectLintError,
    defectBrokenDesign,
  ]);

  const tabs: Array<{ id: SandboxTab; label: string; icon: React.ReactNode }> = [
    { id: 'slicer', label: '1. Spec Slicer', icon: <Scissors className="w-4 h-4" aria-hidden="true" /> },
    { id: 'ast_hashline', label: '2. AST-LOD & Hashline', icon: <FileCode2 className="w-4 h-4" aria-hidden="true" /> },
    { id: 'compressor', label: '3. Log & Diff Compressor', icon: <Terminal className="w-4 h-4" aria-hidden="true" /> },
    { id: 'gate', label: '4. Pre-Review Gate (0 ток.)', icon: <ShieldAlert className="w-4 h-4" aria-hidden="true" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-5 space-y-2">
        <div className="text-xs text-slate-500">
          Интерактивная проверка алгоритмов · Реальный TypeScript-движок SpecTrim
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Песочница модулей SpecTrim
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          Протестируйте каждый из модулей на реальных артефактах OpenSpec change{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">
            add-rate-limit-and-audit
          </code>
          : tree-shaking спеки, Hashline-патчи, сжатие логов и детерминированный Pre-Review Gate.
        </p>
      </div>

      {/* Sub-navigation Tabs */}
      <div
        role="tablist"
        aria-label="Модули SpecTrim"
        className="flex flex-wrap gap-2 border-b border-slate-200 pb-3"
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: Spec Slicer */}
      {activeTab === 'slicer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Выберите задачу для микро-сессии</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Вместо всей спеки ({sliceResult.monolithicTokens} ток.) агент получает только срез под задачу
              </p>
            </div>
            <div className="space-y-1.5" role="listbox" aria-label="Задачи OpenSpec">
              {graph.tasks.map((t) => {
                const selected = t.id === selectedTaskId;
                const reqSummary =
                  t.linkedReqs.length > 3
                    ? `${t.linkedReqs[0]}..${t.linkedReqs[t.linkedReqs.length - 1]} (${t.linkedReqs.length})`
                    : t.linkedReqs.join(', ');
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTaskId(t.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-colors ${
                      selected
                        ? 'border-blue-600 bg-blue-50/70 text-slate-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 font-mono font-semibold">
                      <span className="whitespace-nowrap shrink-0">{t.id}</span>
                      <span className="text-slate-500 truncate">{reqSummary}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-slate-600">
                      {t.title.replace(/`/g, '')}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="lg:col-span-8 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Монолитная спека (Baseline)</div>
                <div className="text-xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                  {sliceResult.monolithicTokens} ток.
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {graph.requirements.length} REQ · {graph.designSections.length} DES · {graph.tasks.length} TSK
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Срез задачи {sliceResult.task.id}</div>
                <div className="text-xl font-bold text-blue-700 font-mono tabular-nums mt-1">
                  {sliceResult.slicedTokens} ток.
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {sliceResult.requirements.length} REQ · {sliceResult.designSections.length} DES · Capsule {sliceResult.stateCapsule.tokens} ток.
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="text-xs text-slate-500">Сжатие контекста задачи</div>
                <div className="text-xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                  −{sliceResult.reductionPct}%
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  +0 токенов старой истории
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Скомпилированный микро-контекст для {sliceResult.task.id}
                </h3>
                <span className="text-xs font-mono text-slate-500">
                  State Capsule @{sliceResult.stateCapsule.hash}
                </span>
              </div>
              <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[420px] leading-relaxed whitespace-pre-wrap">
                {sliceResult.compiledPromptBundle}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: AST-LOD & Hashline */}
      {activeTab === 'ast_hashline' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Адаптивное чтение файла (AST-LOD)
                </h2>
                <p className="text-xs text-slate-500">
                  LOD0 — целевой файл с хэш-якорями · LOD1 — AST-скелет зависимостей · LOD2 — карта репо
                </p>
              </div>
              <div className="inline-flex rounded-lg bg-slate-100 p-1 border border-slate-200 shrink-0">
                {(['LOD0', 'LOD1', 'LOD2'] as LodLevel[]).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLodLevel(lvl)}
                    className={`px-3 py-1 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap ${
                      lodLevel === lvl
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2 tabular-nums">
              <span className="font-mono text-slate-700">src/middleware/rate_limiter.py</span>
              <span className="font-mono">
                {astView.rawTokens} → <strong>{astView.lodTokens} ток.</strong>{' '}
                <span className="text-emerald-700 font-semibold">
                  ({astView.reductionPct > 0 ? `−${astView.reductionPct}%` : 'Hashline anchors'})
                </span>
              </span>
            </div>

            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[380px] leading-relaxed">
              {astView.rendered}
            </pre>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Hashline Patcher (проверка якоря строки)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Правка привязывается к <code className="font-mono">L6#{defaultPatchLine.hash}</code> без пересказа старого кода в output.
              </p>
            </div>

            <div className="space-y-3">
              <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 font-mono text-slate-700">
                Текущая строка: {defaultPatchLine.formatted}
              </div>

              <div>
                <label
                  htmlFor="hashline-replacement"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Новое содержимое строки L{defaultPatchLine.lineNumber}
                </label>
                <input
                  id="hashline-replacement"
                  type="text"
                  value={patchReplacement}
                  onChange={(e) => setPatchReplacement(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label
                  htmlFor="hashline-override"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Хэш-якорь (по умолчанию актуальный #{defaultPatchLine.hash})
                </label>
                <input
                  id="hashline-override"
                  type="text"
                  placeholder={defaultPatchLine.hash}
                  value={patchHashOverride}
                  onChange={(e) => setPatchHashOverride(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleApplyHashlinePatch(false)}
                  className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors whitespace-nowrap"
                >
                  Применить Hashline-патч
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyHashlinePatch(true)}
                  className="px-3.5 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors whitespace-nowrap"
                >
                  Симулировать устаревший хэш (#000)
                </button>
              </div>
            </div>

            {lastPatchResult && (
              <div
                className={`rounded-lg border p-3.5 text-xs space-y-1.5 ${
                  lastPatchResult.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : 'border-red-200 bg-red-50 text-red-900'
                }`}
              >
                <div className="font-semibold flex items-center gap-1.5">
                  {lastPatchResult.ok ? (
                    <>
                      <Check className="w-4 h-4" aria-hidden="true" />
                      Патч применён с 1-го раза
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                      Защита от слепой перезаписи: конфликт хэша
                    </>
                  )}
                </div>
                {lastPatchResult.error ? (
                  <p className="font-mono">{lastPatchResult.error}</p>
                ) : (
                  <p className="tabular-nums">
                    Output токены: {lastPatchResult.naiveRewriteTokens} (str_replace) →{' '}
                    <strong>{lastPatchResult.hashlinePatchTokens}</strong> (Hashline, экономия{' '}
                    {lastPatchResult.savedOutputTokens} ток.)
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Log & Diff Compressor */}
      {activeTab === 'compressor' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg bg-slate-100 p-1 border border-slate-200">
              <button
                type="button"
                onClick={() => setCompressorMode('pytest')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  compressorMode === 'pytest'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Лог pytest
              </button>
              <button
                type="button"
                onClick={() => setCompressorMode('diff')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  compressorMode === 'diff'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Incremental git diff
              </button>
              <button
                type="button"
                onClick={() => setCompressorMode('dedup')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  compressorMode === 'dedup'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Дедупликация чтений файлов
              </button>
            </div>

            {compressorMode !== 'dedup' && (
              <div className="text-xs font-mono text-slate-700 tabular-nums">
                {compressorMode === 'pytest' ? (
                  <>
                    {compressedPytest.rawTokens} →{' '}
                    <strong className="text-emerald-700">
                      {compressedPytest.compressedTokens} ток. (−{compressedPytest.reductionPct}%)
                    </strong>
                  </>
                ) : (
                  <>
                    {compressedDiff.rawTokens} →{' '}
                    <strong className="text-emerald-700">
                      {compressedDiff.compressedTokens} ток. (−{compressedDiff.reductionPct}%)
                    </strong>
                  </>
                )}
              </div>
            )}
          </div>

          {compressorMode === 'dedup' ? (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-900">
                  Перехватчик повторного чтения неизменных файлов в сессии
                </span>
                <span className="font-mono text-emerald-700 font-semibold tabular-nums">
                  {dedupResult.totalRawTokens} → {dedupResult.totalOptimizedTokens} ток. (−{dedupResult.reductionPct}%)
                </span>
              </div>
              <table className="w-full text-left border-collapse text-xs font-mono">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-4">Шаг</th>
                    <th className="py-2.5 px-4">Файл</th>
                    <th className="py-2.5 px-4">Хэш</th>
                    <th className="py-2.5 px-4">Решение перехватчика</th>
                    <th className="py-2.5 px-4 text-right">Токены</th>
                    <th className="py-2.5 px-4 text-right">Сэкономлено</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {dedupResult.events.map((ev) => (
                    <tr key={ev.step}>
                      <td className="py-2.5 px-4">#{ev.step}</td>
                      <td className="py-2.5 px-4">{ev.path}</td>
                      <td className="py-2.5 px-4 text-slate-500">@{ev.hash}</td>
                      <td className="py-2.5 px-4">
                        {ev.status === 'full_read' ? 'Первое чтение (полное)' : 'CACHED_IN_CONTEXT (заглушка)'}
                      </td>
                      <td className="py-2.5 px-4 text-right">{ev.tokensCharged}</td>
                      <td className="py-2.5 px-4 text-right text-emerald-700 font-semibold">
                        {ev.tokensSaved}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="text-xs font-semibold text-slate-700">
                  Сырой вывод инструмента (Baseline)
                </div>
                <pre className="bg-slate-900 text-slate-300 rounded-lg p-3.5 text-xs font-mono overflow-x-auto max-h-[360px] leading-relaxed">
                  {compressorMode === 'pytest' ? DEMO_RAW_PYTEST_LOG : DEMO_RAW_GIT_DIFF}
                </pre>
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="text-xs font-semibold text-emerald-700">
                  Сжатый сигнал SpecTrim (в контекст LLM)
                </div>
                <pre className="bg-slate-900 text-emerald-200 rounded-lg p-3.5 text-xs font-mono overflow-x-auto max-h-[360px] leading-relaxed whitespace-pre-wrap">
                  {compressorMode === 'pytest'
                    ? compressedPytest.compressed
                    : compressedDiff.compressed}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Zero-Token Pre-Review Gate */}
      {activeTab === 'gate' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Симуляция дефектов перед LLM-ревью
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Отметьте дефекты, чтобы убедиться, как локальный Gate ловит их за 0 токенов до вызова нейросети
              </p>
            </div>

            <div className="space-y-2.5">
              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectMissingReqTest}
                  onChange={(e) => setDefectMissingReqTest(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Забыт тест для REQ-07</strong>
                  <span className="text-slate-500">Удаляет @spec:REQ-07 из tests/test_rate_limit_audit.py</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectUncheckedTask}
                  onChange={(e) => setDefectUncheckedTask(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Не отмечена задача TSK-07 в tasks.md</strong>
                  <span className="text-slate-500">Имитация недоделанной задачи в списке чекбоксов</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectBrokenDesign}
                  onChange={(e) => setDefectBrokenDesign(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Рассогласование design.md ↔ specs</strong>
                  <span className="text-slate-500">Сломанная ссылка на несуществующий REQ-99</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectFailingTest}
                  onChange={(e) => setDefectFailingTest(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Падение интеграционного теста</strong>
                  <span className="text-slate-500">AssertionError в test_spool_fallback_on_sink_error</span>
                </span>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectLintError}
                  onChange={(e) => setDefectLintError(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Ошибка линтера (ruff F401)</strong>
                  <span className="text-slate-500">Неиспользуемый импорт в src/audit/audit_logger.py</span>
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => {
                setDefectMissingReqTest(false);
                setDefectUncheckedTask(false);
                setDefectBrokenDesign(false);
                setDefectFailingTest(false);
                setDefectLintError(false);
              }}
              className="w-full py-2 px-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 transition-colors"
            >
              Сбросить дефекты (Зелёный прогон)
            </button>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                Результат spectrim gate add-rate-limit-and-audit
              </h2>
              <span
                className={`text-xs font-mono font-semibold ${
                  gateResult.passed ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {gateResult.passed ? 'PASS · 0 LLM токенов' : 'BLOCKED · 0 LLM токенов'}
              </span>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
              {gateResult.checks.map((chk) => (
                <div key={chk.id} className="px-4 py-3 flex items-start justify-between gap-4 text-xs">
                  <div>
                    <div className="font-semibold text-slate-900">{chk.name}</div>
                    <div className="text-slate-600 mt-0.5">{chk.details}</div>
                  </div>
                  <span
                    className={`font-mono font-semibold shrink-0 ${
                      chk.passed ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {chk.passed ? 'PASS' : 'FAIL'}
                  </span>
                </div>
              ))}
            </div>

            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-700">
                Сжатый ответ агенту (без сжигания токенов ревьюера · сэкономлено ~
                {gateResult.estimatedTokensSaved.toLocaleString('ru-RU')} ток.):
              </div>
              <pre className="bg-slate-900 text-slate-100 rounded-lg p-3.5 text-xs font-mono whitespace-pre-wrap">
                {gateResult.conciseReport}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
