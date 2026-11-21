/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  buildKvCacheLayout,
  DEFAULT_SIMULATION_CONFIG,
  runLocalSimulation,
  SimulationConfig,
} from './engine/abModelSimulation';
import { generateJuryDeliverables } from './engine/juryDeliverables';
import { OverviewBenchmarkView } from './components/OverviewBenchmarkView';
import { ModuleSandboxView } from './components/ModuleSandboxView';
import { PortabilityView } from './components/PortabilityView';
import { JuryReportView } from './components/JuryReportView';
import {
  ActiveBenchmarkState,
  LiveRunProgressEvent,
  WorkbenchStatusResponse,
} from './types/workbench';
import { LlmProviderId } from './engine/provenance';

type AppPage = 'overview' | 'modules' | 'portability' | 'report';

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>('overview');
  const navigateTo = useCallback((page: AppPage) => {
    setActivePage(page);
    window.scrollTo({ top: 0 });
  }, []);

  const [status, setStatus] = useState<WorkbenchStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState<boolean>(true);

  const [selectedRepoPath, setSelectedRepoPath] = useState<string>('benchmarks/orders-ts');
  const [selectedChangeId, setSelectedChangeId] = useState<string>('add-idempotency-and-webhooks');
  const [selectedProvider, setSelectedProvider] = useState<LlmProviderId>('gemini');
  const [selectedModel, setSelectedModel] = useState<string>('gemini-4-hydrogen');
  const [maxReviewIters, setMaxReviewIters] = useState<number>(3);

  const [simConfig, setSimConfig] = useState<SimulationConfig>(DEFAULT_SIMULATION_CONFIG);
  const [measuredState, setMeasuredState] = useState<ActiveBenchmarkState | null>(null);
  const [viewMode, setViewMode] = useState<'measured' | 'simulated'>('simulated');

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isRunningReal, setIsRunningReal] = useState<boolean>(false);
  const [liveEvents, setLiveEvents] = useState<LiveRunProgressEvent[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) return;
      const data = (await resp.json()) as WorkbenchStatusResponse;
      setStatus(data);

      const models = data.provider.availableModels;
      if (models.length > 0) {
        const defaultProv: LlmProviderId =
          data.provider.defaultProvider !== 'none'
            ? data.provider.defaultProvider
            : models[0].provider;
        setSelectedProvider((prevProv) => {
          const hasPrevProvModels = models.some((m) => m.provider === prevProv);
          const nextProv = hasPrevProvModels ? prevProv : defaultProv;
          const provModels = models.filter((m) => m.provider === nextProv);
          setSelectedModel((prevModel) =>
            provModels.some((m) => m.id === prevModel)
              ? prevModel
              : provModels[0]?.id ?? 'gemini-4-hydrogen'
          );
          return nextProv;
        });
      } else if (data.provider.ollamaStatus.reachable) {
        setSelectedProvider('ollama');
        setSelectedModel(data.provider.ollamaStatus.configuredModel || 'qwen2.5-coder:7b');
      }

      if (data.savedRuns.length > 0 && !measuredState) {
        try {
          const runResp = await fetch(`/api/runs/${encodeURIComponent(data.savedRuns[0].runId)}`);
          if (runResp.ok) {
            const runData = await runResp.json();
            if (runData.report && runData.deliverables) {
              setMeasuredState({
                report: runData.report,
                deliverables: runData.deliverables,
                kvCacheLayout: buildKvCacheLayout(true),
              });
              setViewMode('measured');
            }
          }
        } catch {
          // ignore error loading previous run
        }
      }
    } finally {
      setStatusLoading(false);
    }
  }, [measuredState]);

  useEffect(() => {
    void refreshStatus();
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const simulatedState = useMemo<ActiveBenchmarkState>(() => {
    const report = runLocalSimulation(simConfig);
    const deliverables = generateJuryDeliverables(report);
    const kvCacheLayout = buildKvCacheLayout(simConfig.enableDeltaReviewAndCache);
    return { report, deliverables, kvCacheLayout };
  }, [simConfig]);

  const activeData =
    viewMode === 'measured' && measuredState ? measuredState : simulatedState;

  const handleUpdateSimConfig = useCallback((patch: Partial<SimulationConfig>) => {
    setSimConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleRunServerSimulation = useCallback(async () => {
    setRunError(null);
    const resp = await fetch('/api/simulation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simConfig),
    });
    if (resp.ok) {
      setViewMode('simulated');
    }
  }, [simConfig]);

  const handleLoadSavedRun = useCallback(async (runId: string) => {
    setRunError(null);
    const resp = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      setRunError(errData.error || 'Не удалось загрузить сохранённый прогон');
      return;
    }
    const data = await resp.json();
    setMeasuredState({
      report: data.report,
      deliverables: data.deliverables,
      kvCacheLayout: buildKvCacheLayout(true),
    });
    setViewMode('measured');
  }, []);

  const handleStartRealAbRun = useCallback(async () => {
    setRunError(null);
    setLiveEvents([]);
    eventSourceRef.current?.close();

    setIsRunningReal(true);
    try {
      const resp = await fetch('/api/runs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath: selectedRepoPath,
          changeId: selectedChangeId,
          provider: selectedProvider,
          model: selectedModel,
          maxReviewIters,
        }),
      });

      const payload = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRunError(
          payload.error || 'Не удалось запустить реальный A/B прогон через worktree.'
        );
        setIsRunningReal(false);
        return;
      }

      const jobId: string = payload.jobId;
      setActiveJobId(jobId);

      const es = new EventSource(`/api/runs/jobs/${encodeURIComponent(jobId)}/stream`);
      eventSourceRef.current = es;

      es.addEventListener('progress', (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent).data) as LiveRunProgressEvent;
          setLiveEvents((prev) => [...prev, parsed]);
        } catch {
          // ignore malformed SSE progress frame
        }
      });

      es.addEventListener('completed', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data);
          if (data.report && data.deliverables) {
            setMeasuredState({
              report: data.report,
              deliverables: data.deliverables,
              kvCacheLayout: buildKvCacheLayout(true),
            });
            setViewMode('measured');
          }
        } finally {
          es.close();
          setIsRunningReal(false);
          setActiveJobId(null);
          void refreshStatus();
        }
      });

      es.addEventListener('cancelled', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data);
          setRunError(data.error || 'Прогон отменён пользователем.');
        } finally {
          es.close();
          setIsRunningReal(false);
          setActiveJobId(null);
        }
      });

      es.addEventListener('error', (ev) => {
        try {
          const msgEvent = ev as MessageEvent;
          if (msgEvent.data) {
            const data = JSON.parse(msgEvent.data);
            setRunError(data.error || 'Ошибка выполнения реального A/B прогона.');
          }
        } catch {
          setRunError('Поток выполнения прогона прервался.');
        } finally {
          es.close();
          setIsRunningReal(false);
          setActiveJobId(null);
        }
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Сетевая ошибка при запуске A/B');
      setIsRunningReal(false);
    }
  }, [
    selectedRepoPath,
    selectedChangeId,
    selectedProvider,
    selectedModel,
    maxReviewIters,
    refreshStatus,
  ]);

  const handleCancelRealAbRun = useCallback(async () => {
    if (!activeJobId) return;
    await fetch(`/api/runs/jobs/${encodeURIComponent(activeJobId)}/cancel`, {
      method: 'POST',
    });
  }, [activeJobId]);

  const navItems: Array<{ id: AppPage; label: string }> = [
    { id: 'overview', label: 'Обзор A/B' },
    { id: 'modules', label: 'Модули SpecTrim' },
    { id: 'portability', label: 'Портативность' },
    { id: 'report', label: 'Отчёт жюри' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => navigateTo('overview')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            SpecTrim
          </button>

          <nav
            aria-label="Основная навигация"
            className="hidden md:flex items-center gap-6 text-sm font-medium"
          >
            {navItems.map((item) => {
              const active = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    active
                      ? 'text-slate-900 border-blue-600'
                      : 'text-slate-600 border-transparent hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => {
                navigateTo('overview');
                void handleStartRealAbRun();
              }}
              disabled={isRunningReal}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {isRunningReal ? 'Выполняется A/B...' : 'Запустить A/B прогон'}
            </button>
          </div>
        </div>

        {/* Mobile navigation row */}
        <nav
          aria-label="Мобильная навигация"
          className="md:hidden border-t border-slate-100 px-4 py-2 flex items-center gap-4 overflow-x-auto text-xs font-medium"
        >
          {navItems.map((item) => {
            const active = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`py-1 whitespace-nowrap shrink-0 border-b-2 ${
                  active
                    ? 'text-slate-900 border-blue-600'
                    : 'text-slate-600 border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {activePage === 'overview' && (
          <OverviewBenchmarkView
            activeData={activeData}
            viewMode={viewMode}
            onChangeViewMode={setViewMode}
            hasMeasuredRun={Boolean(measuredState)}
            simConfig={simConfig}
            onUpdateSimConfig={handleUpdateSimConfig}
            onRunServerSimulation={handleRunServerSimulation}
            status={status}
            statusLoading={statusLoading}
            selectedRepoPath={selectedRepoPath}
            onChangeRepoPath={(repo) => {
              setSelectedRepoPath(repo);
              const repoInfo = status?.repos.find((r) => r.repoPath === repo);
              if (repoInfo && repoInfo.changes.length > 0) {
                const pendingPrefer =
                  repoInfo.changes.find((c) => c.includes('idempotency')) ?? repoInfo.changes[0];
                setSelectedChangeId(pendingPrefer);
              }
            }}
            selectedChangeId={selectedChangeId}
            onChangeChangeId={setSelectedChangeId}
            selectedProvider={selectedProvider}
            onChangeProvider={(prov) => {
              setSelectedProvider(prov);
              setRunError(null);
              const modelsForProv =
                status?.provider.availableModels.filter((m) => m.provider === prov) ?? [];
              if (modelsForProv.length > 0) {
                setSelectedModel(modelsForProv[0].id);
              } else if (prov === 'gemini') {
                setSelectedModel('gemini-4-hydrogen');
              } else if (prov === 'ollama') {
                setSelectedModel(
                  status?.provider.ollamaStatus.configuredModel || 'qwen2.5-coder:7b'
                );
              } else {
                setSelectedModel('');
              }
            }}
            selectedModel={selectedModel}
            onChangeModel={(modelId) => {
              setSelectedModel(modelId);
              const found = status?.provider.availableModels.find(
                (m) => m.id === modelId && m.provider === selectedProvider
              );
              if (found) setSelectedProvider(found.provider);
            }}
            onRefreshStatus={() => void refreshStatus()}
            maxReviewIters={maxReviewIters}
            onChangeMaxReviewIters={setMaxReviewIters}
            isRunningReal={isRunningReal}
            onStartRealRun={handleStartRealAbRun}
            onCancelRealRun={handleCancelRealAbRun}
            liveEvents={liveEvents}
            runError={runError}
            onLoadSavedRun={handleLoadSavedRun}
          />
        )}
        {activePage === 'modules' && <ModuleSandboxView repos={status?.repos ?? []} />}
        {activePage === 'portability' && <PortabilityView />}
        {activePage === 'report' && (
          <JuryReportView
            report={activeData.report}
            deliverables={activeData.deliverables}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>SpecTrim SDD Token Optimization Workbench</span>
          <span>OpenCode · OpenSpec · Zero-Token Pre-Review Gate</span>
        </div>
      </footer>
    </div>
  );
}
