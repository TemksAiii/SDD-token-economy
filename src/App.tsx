/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useCallback } from 'react';
import {
  AbBenchmarkResult,
  BenchmarkConfig,
  DEFAULT_BENCHMARK_CONFIG,
  runAbBenchmark,
} from './engine/abBenchmark';
import { generateJuryDeliverables, JuryDeliverablesBundle } from './engine/juryDeliverables';
import { OverviewBenchmarkView } from './components/OverviewBenchmarkView';
import { ModuleSandboxView } from './components/ModuleSandboxView';
import { PortabilityView } from './components/PortabilityView';
import { JuryReportView } from './components/JuryReportView';

type AppPage = 'overview' | 'modules' | 'portability' | 'report';

export default function App() {
  const [activePage, setActivePage] = useState<AppPage>('overview');
  const navigateTo = useCallback((page: AppPage) => {
    setActivePage(page);
    window.scrollTo({ top: 0 });
  }, []);
  const [config, setConfig] = useState<BenchmarkConfig>(DEFAULT_BENCHMARK_CONFIG);
  const [serverResult, setServerResult] = useState<{
    benchmark: AbBenchmarkResult;
    deliverables: JuryDeliverablesBundle;
  } | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const localComputed = useMemo(() => {
    const benchmark = runAbBenchmark(config);
    const deliverables = generateJuryDeliverables(benchmark);
    return { benchmark, deliverables };
  }, [config]);

  const activeData = serverResult ?? localComputed;

  const handleUpdateConfig = useCallback((patch: Partial<BenchmarkConfig>) => {
    setServerResult(null);
    setConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleRunServerBenchmark = useCallback(async () => {
    setIsRunning(true);
    try {
      const resp = await fetch('/api/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.benchmark && data.deliverables) {
          setServerResult(data);
        }
      }
    } finally {
      setIsRunning(false);
    }
  }, [config]);

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
          {/* Zone 1: Single-line wordmark */}
          <button
            type="button"
            onClick={() => navigateTo('overview')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            SpecTrim
          </button>

          {/* Zone 2: 4 concise single-line text nav links */}
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

          {/* Zone 3: 1 primary CTA */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => {
                navigateTo('overview');
                void handleRunServerBenchmark();
              }}
              disabled={isRunning}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              {isRunning ? 'Запуск...' : 'Запустить A/B прогон'}
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

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {activePage === 'overview' && (
          <OverviewBenchmarkView
            benchmark={activeData.benchmark}
            config={config}
            onUpdateConfig={handleUpdateConfig}
            onRunBenchmark={handleRunServerBenchmark}
            isRunning={isRunning}
          />
        )}
        {activePage === 'modules' && <ModuleSandboxView />}
        {activePage === 'portability' && <PortabilityView />}
        {activePage === 'report' && (
          <JuryReportView
            deliverables={activeData.deliverables}
            metricsJsonl={activeData.benchmark.metricsJsonl}
          />
        )}
      </main>

      {/* Clean Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>SpecTrim SDD Token Optimization Workbench</span>
          <span>OpenCode · OpenSpec · Zero-Token Pre-Review Gate</span>
        </div>
      </footer>
    </div>
  );
}
