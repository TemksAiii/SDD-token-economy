import React, { useState } from 'react';
import { AbRunReport } from '../engine/provenance';
import { JuryDeliverablesBundle } from '../engine/juryDeliverables';
import { PROVENANCE_LABEL } from '../types/workbench';
import { Check, Copy, Download } from 'lucide-react';

interface JuryReportViewProps {
  report: AbRunReport;
  deliverables: JuryDeliverablesBundle;
}

type DocTab = 'report' | 'repro' | 'demo' | 'slides' | 'opencode' | 'manifest' | 'metrics' | 'diffs';

export const JuryReportView: React.FC<JuryReportViewProps> = ({
  report,
  deliverables,
}) => {
  const [activeDoc, setActiveDoc] = useState<DocTab>('report');
  const [copied, setCopied] = useState<boolean>(false);

  const docMap: Record<DocTab, { title: string; filename: string; content: string }> = {
    report: {
      title: 'REPORT.md — Аналитический отчёт для жюри',
      filename: 'REPORT.md',
      content: deliverables.reportMd,
    },
    repro: {
      title: 'REPRODUCIBILITY.md — Инструкция воспроизведения CLI и A/B worktree',
      filename: 'REPRODUCIBILITY.md',
      content: deliverables.reproducibilityMd,
    },
    demo: {
      title: 'DEMO_SCRIPT.md — Сценарий видео-демонстрации (3:30)',
      filename: 'DEMO_SCRIPT.md',
      content: deliverables.demoScriptMd,
    },
    slides: {
      title: 'PITCH_SLIDES.md — Структура презентации (7 слайдов)',
      filename: 'PITCH_SLIDES.md',
      content: deliverables.pitchSlidesMd,
    },
    opencode: {
      title: 'OpenCode Plugin & AGENTS.md — Конфигурация перехвата',
      filename: 'spectrim-plugin.ts',
      content: `${deliverables.openCodePluginTs}\n\n${deliverables.agentsMdSnippet}`,
    },
    manifest: {
      title: 'run_manifest.json — Манифест идентичности A/B-прогона',
      filename: 'run_manifest.json',
      content: JSON.stringify(report.manifest, null, 2),
    },
    metrics: {
      title: 'metrics.jsonl — Построчная телеметрия A/B-прогона',
      filename: 'metrics.jsonl',
      content: report.metricsJsonl,
    },
    diffs: {
      title: 'baseline.diff & optimized.diff — Диффы изолированных worktree',
      filename: 'ab-diffs.patch',
      content: `=== BASELINE DIFF ===\n${report.baselineDiff}\n\n=== SPECTRIM (OPTIMIZED) DIFF ===\n${report.optimizedDiff}`,
    },
  };

  const current = docMap[activeDoc];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard fallback ignored if blocked in headless sandbox
    }
  };

  const handleDownload = () => {
    const blob = new Blob([current.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = current.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const tabs: Array<{ id: DocTab; label: string }> = [
    { id: 'report', label: 'REPORT.md' },
    { id: 'repro', label: 'REPRODUCIBILITY.md' },
    { id: 'demo', label: 'DEMO_SCRIPT.md' },
    { id: 'slides', label: 'PITCH_SLIDES.md' },
    { id: 'opencode', label: 'OpenCode Plugin' },
    { id: 'manifest', label: 'run_manifest.json' },
    { id: 'metrics', label: 'metrics.jsonl' },
    { id: 'diffs', label: 'git diff' },
  ];

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-5 space-y-2">
        <div className="text-xs text-slate-500">
          {PROVENANCE_LABEL[report.provenance]} · Run ID: {report.manifest.runId}
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Артефакты отчёта и воспроизводимости
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          Все документы,{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">run_manifest.json</code>,{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">metrics.jsonl</code> и diff-артефакты синхронизированы с активным отчётом и явно указывают его provenance.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Артефакты отчёта" className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeDoc === tab.id}
              type="button"
              onClick={() => setActiveDoc(tab.id)}
              className={`px-3 py-2 text-xs font-mono font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
                activeDoc === tab.id
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                Скопировано
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                Копировать
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs font-medium text-white transition-colors whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Скачать {current.filename}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-800">{current.title}</span>
          <span className="font-mono text-slate-500 tabular-nums">
            {current.content.split('\n').length} строк
          </span>
        </div>
        <pre className="p-5 text-xs font-mono text-slate-800 overflow-x-auto max-h-[560px] leading-relaxed whitespace-pre-wrap">
          {current.content}
        </pre>
      </div>
    </div>
  );
};
