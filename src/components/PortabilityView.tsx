import React, { useMemo, useState } from 'react';
import { DEMO_REPO_PROBES } from '../data/demoWorkspace';
import { analyzeRepoPortability, detectStackFromManifest } from '../engine/portability';
import { Check } from 'lucide-react';

export const PortabilityView: React.FC = () => {
  const analyses = useMemo(
    () => DEMO_REPO_PROBES.map((probe) => ({ probe, result: analyzeRepoPortability(probe) })),
    []
  );
  const [selectedRepoId, setSelectedRepoId] = useState<string>(DEMO_REPO_PROBES[0].id);
  const [customManifestName, setCustomManifestName] = useState<'pyproject.toml' | 'package.json' | 'go.mod'>('package.json');
  const [customManifestBody, setCustomManifestBody] = useState<string>(
    '{\n  "name": "billing-worker",\n  "packageManager": "pnpm@9",\n  "devDependencies": { "vitest": "^2.1.0", "typescript": "^5.6.0" }\n}'
  );

  const activeEntry = analyses.find((a) => a.probe.id === selectedRepoId) ?? analyses[0];
  const customDetected = useMemo(
    () => detectStackFromManifest(customManifestName, customManifestBody),
    [customManifestName, customManifestBody]
  );

  return (
    <div className="space-y-8">
      <div className="border-b border-slate-200 pb-5 space-y-2">
        <div className="text-xs text-slate-500">
          Критерий жюри: Портативность · Zero-Config автодетект по манифесту
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Портативность между языками и репозиториями
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          SpecTrim работает поверх стандартного каталога <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">openspec/changes/&lt;id&gt;/</code>{' '}
          и автоматически определяет язык, пакетный менеджер, test-runner, линтер и AST-скелеты без единой правки кода ядра.
        </p>
      </div>

      {/* Repo Selector Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {analyses.map(({ probe, result }) => {
          const active = probe.id === selectedRepoId;
          return (
            <button
              key={probe.id}
              type="button"
              onClick={() => setSelectedRepoId(probe.id)}
              className={`text-left rounded-xl border p-5 transition-colors space-y-2 ${
                active
                  ? 'border-blue-600 bg-blue-50/40'
                  : 'border-slate-200 bg-white hover:bg-slate-50'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-mono text-slate-500">
                <span>{probe.manifestFile}</span>
                <span className="text-emerald-700 font-semibold tabular-nums">
                  AST −{result.astReductionPct}%
                </span>
              </div>
              <div className="text-sm font-semibold text-slate-900">{probe.name}</div>
              <div className="text-xs text-slate-600 font-mono">
                {result.detectedLanguage} · {result.packageManager}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected Repo Details */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Автоопределённый стек
            </h2>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              0 правок кода
            </span>
          </div>

          <dl className="divide-y divide-slate-100 text-xs">
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">Манифест</dt>
              <dd className="font-mono font-semibold text-slate-900">{activeEntry.result.manifestFile}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">Язык и менеджер</dt>
              <dd className="font-mono text-slate-900">
                {activeEntry.result.detectedLanguage} ({activeEntry.result.packageManager})
              </dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">Test Runner (для Gate)</dt>
              <dd className="font-mono text-slate-900">{activeEntry.result.testCommand}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">Линтер / Typecheck</dt>
              <dd className="font-mono text-slate-900">{activeEntry.result.lintCommand}</dd>
            </div>
            <div className="py-2.5 flex justify-between gap-4">
              <dt className="text-slate-500">Маркер трассировки</dt>
              <dd className="font-mono text-blue-700">{activeEntry.result.specMarkerSyntax}</dd>
            </div>
          </dl>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-slate-700">
              Содержимое {activeEntry.probe.manifestFile}
            </div>
            <pre className="bg-slate-900 text-slate-200 rounded-lg p-3.5 text-xs font-mono overflow-x-auto leading-relaxed">
              {activeEntry.probe.manifestContent}
            </pre>
          </div>
        </div>

        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">
              Универсальный AST-LOD1 скелет ({activeEntry.probe.sampleFilePath})
            </h2>
            <span className="text-xs font-mono text-emerald-700 font-semibold tabular-nums">
              {activeEntry.result.rawTokens} → {activeEntry.result.skeletonTokens} ток. (−
              {activeEntry.result.astReductionPct}%)
            </span>
          </div>

          <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[360px] leading-relaxed">
            {activeEntry.result.astSkeletonPreview}
          </pre>
        </div>
      </section>

      {/* Interactive Manifest Probe Tester */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Проверить автоопределение на произвольном манифесте
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Вставьте содержимое своего манифеста, чтобы проверить адаптер без настройки конфигов
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          <div className="lg:col-span-7 space-y-3">
            <div className="flex items-center gap-3">
              <label htmlFor="manifest-select" className="text-xs font-medium text-slate-700">
                Тип манифеста:
              </label>
              <select
                id="manifest-select"
                value={customManifestName}
                onChange={(e) =>
                  setCustomManifestName(
                    e.target.value as 'pyproject.toml' | 'package.json' | 'go.mod'
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono bg-white text-slate-900"
              >
                <option value="package.json">package.json</option>
                <option value="pyproject.toml">pyproject.toml</option>
                <option value="go.mod">go.mod</option>
              </select>
            </div>
            <textarea
              aria-label="Содержимое манифеста проекта"
              rows={5}
              value={customManifestBody}
              onChange={(e) => setCustomManifestBody(e.target.value)}
              className="w-full rounded-lg border border-slate-300 p-3 text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="lg:col-span-5 bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
            <div className="font-semibold text-slate-900">Определённая конфигурация</div>
            <div className="font-mono text-slate-700">
              Язык: <strong>{customDetected.language}</strong>
            </div>
            <div className="font-mono text-slate-700">
              Пакетный менеджер: <strong>{customDetected.packageManager}</strong>
            </div>
            <div className="font-mono text-slate-700">
              Команда тестов: <strong>{customDetected.testCommand}</strong>
            </div>
            <div className="font-mono text-slate-700">
              Команда линта: <strong>{customDetected.lintCommand}</strong>
            </div>
            <div className="font-mono text-blue-700">
              Маркер спеки: <strong>{customDetected.specMarkerSyntax}</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
