import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEMO_RAW_GIT_DIFF,
  DEMO_RAW_PYTEST_LOG,
} from '../data/demoFixtures';
import { TraceabilityGraph, TaskSliceResult } from '../engine/specSlicer';
import {
  applyHashlinePatch,
  AstLodView,
  formatWithHashlines,
  LodLevel,
  SupportedLanguage,
} from '../engine/astLodHashline';
import {
  compressGitDiff,
  compressTestLog,
  deduplicateFileReads,
  TestRunnerKind,
} from '../engine/outputCompressor';
import { PreReviewGateResult } from '../engine/preReviewGate';
import { PROVENANCE_LABEL, WorkspaceRepoInfo } from '../types/workbench';
import {
  AlertTriangle,
  Check,
  FileCode2,
  Play,
  Scissors,
  ShieldAlert,
  Terminal,
} from 'lucide-react';

type SandboxTab = 'slicer' | 'ast_hashline' | 'compressor' | 'gate';

interface ModuleSandboxViewProps {
  repos: WorkspaceRepoInfo[];
}

interface RealGateResponse {
  repoPath: string;
  changeId: string;
  provenance: 'measured_local';
  gate: PreReviewGateResult;
  testCommand: string;
  testExitCode: number;
  testDurationMs: number;
  rawTestOutput: string;
  lintCommand: string;
  lintExitCode: number;
  lintDurationMs: number;
  defectsInjected: boolean;
}

export const ModuleSandboxView: React.FC<ModuleSandboxViewProps> = ({ repos }) => {
  const [activeTab, setActiveTab] = useState<SandboxTab>('slicer');

  const openSpecRepos = useMemo(
    () => repos.filter((r) => r.changes.length > 0),
    [repos]
  );

  const [selectedRepoPath, setSelectedRepoPath] = useState<string>('benchmarks/orders-ts');
  const [selectedChangeId, setSelectedChangeId] = useState<string>('add-rate-limit-and-audit');

  const activeRepoMeta = useMemo(
    () =>
      openSpecRepos.find((r) => r.repoPath === selectedRepoPath) ??
      openSpecRepos[0] ??
      null,
    [openSpecRepos, selectedRepoPath]
  );

  // 1. Spec Slicer state (from real disk OpenSpec files)
  const [graph, setGraph] = useState<TraceabilityGraph | null>(null);
  const [repoFiles, setRepoFiles] = useState<Array<{ path: string; isTest: boolean; bytes: number }>>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>('TSK-01');
  const [sliceResult, setSliceResult] = useState<TaskSliceResult | null>(null);
  const [inspectLoading, setInspectLoading] = useState<boolean>(true);
  const [inspectError, setInspectError] = useState<string | null>(null);

  // 2. AST-LOD & Hashline state (real files on disk)
  const [lodLevel, setLodLevel] = useState<LodLevel>('LOD1');
  const [selectedFilePath, setSelectedFilePath] = useState<string>('src/orders.ts');
  const [fileLanguage, setFileLanguage] = useState<SupportedLanguage>('typescript');
  const [sourceCode, setSourceCode] = useState<string>('');
  const [astView, setAstView] = useState<AstLodView | null>(null);
  const [patchLineNumber, setPatchLineNumber] = useState<number>(1);
  const [patchHashOverride, setPatchHashOverride] = useState<string>('');
  const [patchReplacement, setPatchReplacement] = useState<string>('');
  const [lastPatchResult, setLastPatchResult] = useState<ReturnType<typeof applyHashlinePatch> | null>(
    null
  );

  // 3. Log & Diff Compressor state
  const [compressorMode, setCompressorMode] = useState<'test' | 'diff' | 'dedup'>('test');
  const [rawTestInput, setRawTestInput] = useState<string>(DEMO_RAW_PYTEST_LOG);
  const [testRunnerKind, setTestRunnerKind] = useState<TestRunnerKind>('pytest');
  const [rawDiffInput, setRawDiffInput] = useState<string>(DEMO_RAW_GIT_DIFF);

  // 4. Real Zero-Token Pre-Review Gate state
  const [gateReport, setGateReport] = useState<RealGateResponse | null>(null);
  const [gateRunning, setGateRunning] = useState<boolean>(false);
  const [gateError, setGateError] = useState<string | null>(null);
  const [defectMissingReqTest, setDefectMissingReqTest] = useState<boolean>(false);
  const [defectUncheckedTask, setDefectUncheckedTask] = useState<boolean>(false);
  const [defectFailingTest, setDefectFailingTest] = useState<boolean>(false);
  const [defectLintError, setDefectLintError] = useState<boolean>(false);
  const [defectBrokenDesign, setDefectBrokenDesign] = useState<boolean>(false);

  // Load OpenSpec bundle & file list from disk
  useEffect(() => {
    let active = true;
    setInspectLoading(true);
    setInspectError(null);
    fetch(
      `/api/fs/inspect?repo=${encodeURIComponent(selectedRepoPath)}&change=${encodeURIComponent(
        selectedChangeId
      )}`
    )
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Не удалось прочитать OpenSpec на диске');
        return d;
      })
      .then((data) => {
        if (!active) return;
        const g = data.graph as TraceabilityGraph;
        const files = (data.files ?? []) as Array<{ path: string; isTest: boolean; bytes: number }>;
        setGraph(g);
        setRepoFiles(files);
        if (g.tasks.length > 0) {
          const prefer = g.tasks.find((t) => t.id === 'TSK-07') ?? g.tasks[0];
          setSelectedTaskId(prefer.id);
        }
        const preferredFile =
          files.find((f) => !f.isTest && !f.path.endsWith('__init__.py')) ?? files[0];
        if (preferredFile) {
          setSelectedFilePath(preferredFile.path);
        }
      })
      .catch((err) => {
        if (!active) return;
        setInspectError(err instanceof Error ? err.message : 'Ошибка чтения OpenSpec');
      })
      .finally(() => {
        if (active) setInspectLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedRepoPath, selectedChangeId]);

  // Slice task on server whenever repo/change/task changes
  useEffect(() => {
    if (!selectedTaskId) return;
    let active = true;
    fetch('/api/fs/slice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: selectedRepoPath,
        changeId: selectedChangeId,
        taskId: selectedTaskId,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active || !data?.slice) return;
        setSliceResult(data.slice as TaskSliceResult);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedRepoPath, selectedChangeId, selectedTaskId]);

  // Fetch AST-LOD view from disk when repo / file / level changes
  const loadAstFile = useCallback(
    async (file: string, level: LodLevel, inlineContent?: string) => {
      const resp = await fetch('/api/fs/ast-lod', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: selectedRepoPath,
          filePath: file,
          level,
          content: inlineContent,
        }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      setFileLanguage(data.language as SupportedLanguage);
      if (typeof inlineContent !== 'string') {
        setSourceCode(data.rawContent);
        const lines = formatWithHashlines(data.rawContent).lines;
        const target = lines.find((l) => l.content.trim().length > 0 && !l.content.trim().startsWith('import')) ?? lines[0];
        if (target) {
          setPatchLineNumber(target.lineNumber);
          setPatchReplacement(target.content);
          setPatchHashOverride('');
          setLastPatchResult(null);
        }
      }
      setAstView(data.view as AstLodView);
    },
    [selectedRepoPath]
  );

  useEffect(() => {
    if (!selectedFilePath) return;
    void loadAstFile(selectedFilePath, lodLevel);
  }, [selectedRepoPath, selectedFilePath, lodLevel, loadAstFile]);

  const hashedSource = useMemo(() => formatWithHashlines(sourceCode), [sourceCode]);
  const activePatchLine =
    hashedSource.lines.find((l) => l.lineNumber === patchLineNumber) ??
    hashedSource.lines[0] ?? {
      lineNumber: 1,
      hash: '000',
      content: '',
      formatted: 'L1#000: ',
    };

  const handleApplyHashlinePatch = async (useStaleHash: boolean) => {
    const hashToUse = useStaleHash
      ? '000'
      : patchHashOverride.trim() || activePatchLine.hash;

    const resp = await fetch('/api/hashline-patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: sourceCode,
        patch: {
          startLine: activePatchLine.lineNumber,
          startHash: hashToUse,
          endLine: activePatchLine.lineNumber,
          endHash: hashToUse,
          replacement: patchReplacement,
        },
      }),
    });
    const res = await resp.json();
    setLastPatchResult(res);
    if (res.ok && typeof res.updatedContent === 'string') {
      setSourceCode(res.updatedContent);
      void loadAstFile(selectedFilePath, lodLevel, res.updatedContent);
    }
  };

  // Run real Zero-Token Pre-Review Gate on disk
  const runRealGate = useCallback(async () => {
    setGateRunning(true);
    setGateError(null);
    try {
      const resp = await fetch('/api/fs/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: selectedRepoPath,
          changeId: selectedChangeId,
          injectDefects: {
            missingReqTest: defectMissingReqTest,
            uncheckedTask: defectUncheckedTask,
            failingTest: defectFailingTest,
            lintError: defectLintError,
            brokenDesignRef: defectBrokenDesign,
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setGateError(data.error || 'Ошибка запуска локальной проверки');
        return;
      }
      setGateReport(data as RealGateResponse);
    } catch (err) {
      setGateError(err instanceof Error ? err.message : 'Сетевая ошибка');
    } finally {
      setGateRunning(false);
    }
  }, [
    selectedRepoPath,
    selectedChangeId,
    defectMissingReqTest,
    defectUncheckedTask,
    defectFailingTest,
    defectLintError,
    defectBrokenDesign,
  ]);

  // Auto-run real gate when opening Gate tab for the first time
  useEffect(() => {
    if (activeTab === 'gate' && !gateReport && !gateRunning) {
      void runRealGate();
    }
  }, [activeTab, gateReport, gateRunning, runRealGate]);

  const compressedTest = useMemo(
    () => compressTestLog(rawTestInput, testRunnerKind),
    [rawTestInput, testRunnerKind]
  );
  const compressedDiff = useMemo(
    () => compressGitDiff(rawDiffInput, { 'src/api/orders_router.py': '552a99c' }),
    [rawDiffInput]
  );
  const dedupResult = useMemo(() => {
    const sample = sourceCode || 'export const ok = true;';
    return deduplicateFileReads([
      { step: 1, path: selectedFilePath || 'src/orders.ts', content: sample },
      { step: 3, path: selectedFilePath || 'src/orders.ts', content: sample },
      { step: 6, path: selectedFilePath || 'src/orders.ts', content: sample },
      { step: 9, path: selectedFilePath || 'src/orders.ts', content: sample },
    ]);
  }, [sourceCode, selectedFilePath]);

  const tabs: Array<{ id: SandboxTab; label: string; icon: React.ReactNode }> = [
    { id: 'slicer', label: '1. Spec Slicer', icon: <Scissors className="w-4 h-4" aria-hidden="true" /> },
    { id: 'ast_hashline', label: '2. AST-LOD & Hashline', icon: <FileCode2 className="w-4 h-4" aria-hidden="true" /> },
    { id: 'compressor', label: '3. Log & Diff Compressor', icon: <Terminal className="w-4 h-4" aria-hidden="true" /> },
    { id: 'gate', label: '4. Pre-Review Gate (0 ток.)', icon: <ShieldAlert className="w-4 h-4" aria-hidden="true" /> },
  ];

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-5 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <div className="space-y-2">
          <div className="text-xs text-slate-500">
            {PROVENANCE_LABEL.measured_local} · Реальные файлы OpenSpec и исходники на диске
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Модули SpecTrim на реальном репозитории
          </h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Выберите репозиторий и OpenSpec change на диске: tree-shaking спеки, AST-LOD1 + Hashline-патчи, сжатие логов и запуск реальных тестов в Pre-Review Gate за 0 LLM-токенов.
          </p>
        </div>

        {/* Real Disk Repo & Change Selectors */}
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div>
            <label htmlFor="sandbox-repo" className="block text-xs font-medium text-slate-600 mb-1">
              Репозиторий
            </label>
            <select
              id="sandbox-repo"
              value={selectedRepoPath}
              onChange={(e) => {
                const nextRepo = e.target.value;
                setSelectedRepoPath(nextRepo);
                setGateReport(null);
                const meta = openSpecRepos.find((r) => r.repoPath === nextRepo);
                if (meta && meta.changes.length > 0) {
                  setSelectedChangeId(meta.changes[0]);
                }
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              {(openSpecRepos.length > 0
                ? openSpecRepos
                : [{ repoPath: 'benchmarks/orders-ts', language: 'typescript', changes: ['add-rate-limit-and-audit'] }]
              ).map((r) => (
                <option key={r.repoPath} value={r.repoPath}>
                  {r.repoPath} ({r.language})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="sandbox-change" className="block text-xs font-medium text-slate-600 mb-1">
              OpenSpec Change
            </label>
            <select
              id="sandbox-change"
              value={selectedChangeId}
              onChange={(e) => {
                setSelectedChangeId(e.target.value);
                setGateReport(null);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
            >
              {(activeRepoMeta?.changes ?? ['add-rate-limit-and-audit', 'add-idempotency-and-webhooks']).map(
                (ch) => (
                  <option key={ch} value={ch}>
                    {ch}
                  </option>
                )
              )}
            </select>
          </div>
        </div>
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

      {inspectError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-900">
          {inspectError}
        </div>
      )}

      {/* TAB 1: Spec Slicer */}
      {activeTab === 'slicer' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Задачи OpenSpec ({selectedChangeId})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {inspectLoading
                  ? 'Чтение tasks.md с диска...'
                  : sliceResult
                  ? `Монолитная спека: ${sliceResult.monolithicTokens} ток.`
                  : 'Выберите задачу для среза'}
              </p>
            </div>
            <div className="space-y-1.5" role="listbox" aria-label="Задачи OpenSpec">
              {(graph?.tasks ?? []).map((t) => {
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
                      <span className="whitespace-nowrap shrink-0">
                        [{t.completed ? 'x' : ' '}] {t.id}
                      </span>
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
            {sliceResult && graph ? (
              <>
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
                    <div className="text-xs text-slate-500">Сжатие спеки</div>
                    <div className="text-xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                      −{sliceResult.reductionPct}%
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      +0 токенов старой истории диалога
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Скомпилированный микро-контекст для {sliceResult.task.id} (из файлов на диске)
                    </h3>
                    <span className="text-xs font-mono text-slate-500">
                      State Capsule @{sliceResult.stateCapsule.hash}
                    </span>
                  </div>
                  <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[420px] leading-relaxed whitespace-pre-wrap">
                    {sliceResult.compiledPromptBundle}
                  </pre>
                </div>
              </>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-6 text-xs text-slate-500">
                Загрузка среза спеки...
              </div>
            )}
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
                  Адаптивное чтение файла с диска (AST-LOD)
                </h2>
                <p className="text-xs text-slate-500">
                  LOD0 — целевой файл с хэш-якорями · LOD1 — AST-скелет ({fileLanguage}) · LOD2 — дерево репо
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

            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2 text-xs">
              <div className="flex items-center gap-2">
                <label htmlFor="ast-file-select" className="font-medium text-slate-700">
                  Файл:
                </label>
                <select
                  id="ast-file-select"
                  value={selectedFilePath}
                  onChange={(e) => setSelectedFilePath(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 font-mono text-xs text-slate-900"
                >
                  {repoFiles.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path}
                    </option>
                  ))}
                </select>
              </div>
              {astView && (
                <span className="font-mono tabular-nums">
                  {astView.rawTokens} → <strong>{astView.lodTokens} ток.</strong>{' '}
                  <span className="text-emerald-700 font-semibold">
                    ({astView.reductionPct > 0 ? `−${astView.reductionPct}%` : 'Hashline anchors'})
                  </span>
                </span>
              )}
            </div>

            <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[380px] leading-relaxed">
              {astView?.rendered ?? 'Чтение файла с диска...'}
            </pre>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Hashline Patcher (проверка якоря строки)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Правка проверяется в памяти по якорю <code className="font-mono">L{activePatchLine.lineNumber}#{activePatchLine.hash}</code> без порчи git HEAD репозитория.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label htmlFor="hashline-line-num" className="block text-xs font-medium text-slate-700 mb-1">
                  Строка для патча
                </label>
                <select
                  id="hashline-line-num"
                  value={patchLineNumber}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    setPatchLineNumber(num);
                    const found = hashedSource.lines.find((l) => l.lineNumber === num);
                    if (found) setPatchReplacement(found.content);
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-mono text-slate-900"
                >
                  {hashedSource.lines.slice(0, 40).map((l) => (
                    <option key={l.lineNumber} value={l.lineNumber}>
                      L{l.lineNumber}#{l.hash}: {l.content.slice(0, 52)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="hashline-replacement"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Новое содержимое строки L{activePatchLine.lineNumber}
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
                  Хэш-якорь (по умолчанию актуальный #{activePatchLine.hash})
                </label>
                <input
                  id="hashline-override"
                  type="text"
                  placeholder={activePatchLine.hash}
                  value={patchHashOverride}
                  onChange={(e) => setPatchHashOverride(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleApplyHashlinePatch(false)}
                  className="px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors whitespace-nowrap"
                >
                  Применить Hashline-патч
                </button>
                <button
                  type="button"
                  onClick={() => void handleApplyHashlinePatch(true)}
                  className="px-3.5 py-2 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors whitespace-nowrap"
                >
                  Тест устаревшего хэша (#000)
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
                    Output токены: {lastPatchResult.naiveRewriteTokens} (перезапись файла) →{' '}
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
                onClick={() => setCompressorMode('test')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  compressorMode === 'test'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Лог тестов
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
                Дедупликация чтений
              </button>
            </div>

            {compressorMode === 'test' && (
              <div className="flex items-center gap-3 text-xs">
                <label htmlFor="runner-kind" className="text-slate-600 font-medium">
                  Формат раннера:
                </label>
                <select
                  id="runner-kind"
                  value={testRunnerKind}
                  onChange={(e) => setTestRunnerKind(e.target.value as TestRunnerKind)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 font-mono text-xs"
                >
                  <option value="pytest">pytest</option>
                  <option value="node_test">node:test (TAP)</option>
                  <option value="unittest">python unittest</option>
                  <option value="vitest">vitest / jest</option>
                  <option value="go_test">go test</option>
                  <option value="junit">junit</option>
                </select>
                {gateReport?.rawTestOutput && (
                  <button
                    type="button"
                    onClick={() => {
                      setRawTestInput(gateReport.rawTestOutput);
                      setTestRunnerKind(activeRepoMeta?.testRunnerKind ?? 'node_test');
                    }}
                    className="px-2.5 py-1 rounded border border-blue-300 bg-blue-50 text-blue-800 font-medium hover:bg-blue-100 whitespace-nowrap"
                  >
                    Вставить реальный вывод Gate
                  </button>
                )}
              </div>
            )}

            {compressorMode !== 'dedup' && (
              <div className="text-xs font-mono text-slate-700 tabular-nums">
                {compressorMode === 'test' ? (
                  <>
                    {compressedTest.rawTokens} →{' '}
                    <strong className="text-emerald-700">
                      {compressedTest.compressedTokens} ток. (−{compressedTest.reductionPct}%)
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
                  Перехватчик повторного чтения файла {selectedFilePath} в одной сессии
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
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">
                    Сырой вывод инструмента (можно редактировать)
                  </span>
                  <span className="text-slate-500">{PROVENANCE_LABEL.demo_fixture}</span>
                </div>
                <textarea
                  aria-label="Сырой вывод инструмента для сжатия"
                  rows={14}
                  value={compressorMode === 'test' ? rawTestInput : rawDiffInput}
                  onChange={(e) =>
                    compressorMode === 'test'
                      ? setRawTestInput(e.target.value)
                      : setRawDiffInput(e.target.value)
                  }
                  className="w-full bg-slate-900 text-slate-200 rounded-lg p-3.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                <div className="text-xs font-semibold text-emerald-700">
                  Сжатый сигнал SpecTrim (в контекст LLM)
                </div>
                <pre className="bg-slate-900 text-emerald-200 rounded-lg p-3.5 text-xs font-mono overflow-x-auto max-h-[340px] leading-relaxed whitespace-pre-wrap">
                  {compressorMode === 'test'
                    ? compressedTest.compressed
                    : compressedDiff.compressed}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Real Zero-Token Pre-Review Gate */}
      {activeTab === 'gate' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Реальный Zero-Token Gate на диске
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Выполняет <code className="font-mono">{activeRepoMeta?.testCommand ?? 'тесты'}</code> и <code className="font-mono">{activeRepoMeta?.lintCommand ?? 'линтер'}</code> + проверяет <code className="font-mono">@spec:REQ-XX</code> и <code className="font-mono">tasks.md</code> за 0 LLM-токенов.
              </p>
            </div>

            <button
              type="button"
              onClick={() => void runRealGate()}
              disabled={gateRunning}
              className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-medium transition-colors"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              {gateRunning
                ? 'Запуск тестов и tsc на диске...'
                : 'Запустить реальную проверку (0 LLM токенов)'}
            </button>

            <div className="border-t border-slate-200 pt-3 space-y-2.5">
              <div className="text-xs font-semibold text-slate-700">
                Необязательная тестовая инъекция дефектов (в памяти):
              </div>
              <label className="flex items-start gap-2.5 cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={defectMissingReqTest}
                  onChange={(e) => setDefectMissingReqTest(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span>
                  <strong className="text-slate-900 block">Убрать @spec:REQ из тестов</strong>
                  <span className="text-slate-500">Имитация забытого теста требования</span>
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
                  <strong className="text-slate-900 block">Снять отметку задачи в tasks.md</strong>
                  <span className="text-slate-500">Имитация незавершённого чекбокса</span>
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
                  <span className="text-slate-500">Ссылка на несуществующий REQ-99</span>
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
                  <strong className="text-slate-900 block">Смоделировать падение теста</strong>
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
                  <strong className="text-slate-900 block">Смоделировать ошибку линтера</strong>
                </span>
              </label>
            </div>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            {gateError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                {gateError}
              </div>
            )}

            {gateReport ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Результат spectrim gate {gateReport.changeId}
                    </h2>
                    <div className="text-xs text-slate-500 tabular-nums">
                      {gateReport.defectsInjected
                        ? 'Тестовая инъекция дефекта активна'
                        : PROVENANCE_LABEL.measured_local}{' '}
                      · Тесты: {gateReport.testDurationMs} мс (exit {gateReport.testExitCode}) ·
                      Lint: {gateReport.lintDurationMs} мс (exit {gateReport.lintExitCode})
                    </div>
                  </div>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      gateReport.gate.passed ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {gateReport.gate.passed ? 'PASS · 0 LLM токенов' : 'BLOCKED · 0 LLM токенов'}
                  </span>
                </div>

                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                  {gateReport.gate.checks.map((chk) => (
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
                    Сжатый сигнал агенту (0 LLM токенов · экономия ревью ~
                    {gateReport.gate.estimatedTokensSaved.toLocaleString('ru-RU')} ток.):
                  </div>
                  <pre className="bg-slate-900 text-slate-100 rounded-lg p-3.5 text-xs font-mono whitespace-pre-wrap">
                    {gateReport.gate.conciseReport}
                  </pre>
                </div>
              </>
            ) : (
              <div className="text-xs text-slate-500 py-8 text-center">
                {gateRunning
                  ? 'Выполнение реальных тестов и проверки типов...'
                  : 'Нажмите «Запустить реальную проверку», чтобы выполнить тесты и проверки на диске.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
