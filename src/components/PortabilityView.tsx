import React, { useEffect, useMemo, useState } from 'react';
import { detectStackFromManifest } from '../engine/portability';
import { PROVENANCE_LABEL } from '../types/workbench';
import { Check } from 'lucide-react';

interface DiskRepoPortabilityReport {
  repoPath: string;
  repoName: string;
  manifestFile: string;
  manifestContent: string;
  detectedLanguage: string;
  packageManager: string;
  testCommand: string;
  testRunnerKind: string;
  lintCommand: string;
  specMarkerSyntax: string;
  changes: string[];
  sourceFileCount: number;
  isGitRepo: boolean;
  sampleFilePath: string;
  sampleSourceCode: string;
  astSkeletonPreview: string;
  rawTokens: number;
  skeletonTokens: number;
  astReductionPct: number;
  provenance: 'measured_local';
}

export const PortabilityView: React.FC = () => {
  const [repos, setRepos] = useState<DiskRepoPortabilityReport[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string>('benchmarks/orders-ts');

  const [customManifestName, setCustomManifestName] = useState<
    'package.json' | 'pyproject.toml' | 'go.mod' | 'pom.xml'
  >('package.json');
  const [customManifestBody, setCustomManifestBody] = useState<string>(
    '{\n  "name": "billing-worker",\n  "packageManager": "pnpm@9",\n  "devDependencies": { "vitest": "^2.1.0", "typescript": "^5.6.0" }\n}'
  );

  useEffect(() => {
    let active = true;
    fetch('/api/fs/portability')
      .then(async (r) => {
        if (!r.ok) throw new Error('Не удалось просканировать репозитории на диске');
        return r.json();
      })
      .then((data) => {
        if (!active) return;
        const list = (data.repos ?? []) as DiskRepoPortabilityReport[];
        setRepos(list);
        if (list.length > 0) {
          setSelectedRepoPath(list[0].repoPath);
        }
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Ошибка сканирования');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const activeRepo = repos.find((r) => r.repoPath === selectedRepoPath) ?? repos[0] ?? null;

  const customDetected = useMemo(
    () => detectStackFromManifest(customManifestName, customManifestBody),
    [customManifestName, customManifestBody]
  );

  return (
    <div className="space-y-8">
      <div className="border-b border-slate-200 pb-5 space-y-2">
        <div className="text-xs text-slate-500">
          {PROVENANCE_LABEL.measured_local} · Сканирование реальных репозиториев на диске
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Портативность между языками и репозиториями
        </h1>
        <p className="text-sm text-slate-600 max-w-3xl">
          SpecTrim считывает манифесты (<code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">package.json</code>,{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">pyproject.toml</code>,{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">go.mod</code>,{' '}
          <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">pom.xml</code>) прямо с диска и строит AST-скелеты без переписывания ядра.
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 rounded-xl border border-slate-200 bg-white animate-pulse p-5" />
          ))}
        </div>
      ) : error ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-900">
          {error}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {repos.map((repo) => {
              const active = repo.repoPath === activeRepo?.repoPath;
              return (
                <button
                  key={repo.repoPath}
                  type="button"
                  onClick={() => setSelectedRepoPath(repo.repoPath)}
                  className={`text-left rounded-xl border p-5 transition-colors space-y-2 ${
                    active
                      ? 'border-blue-600 bg-blue-50/40'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs font-mono text-slate-500">
                    <span>{repo.manifestFile}</span>
                    <span className="text-emerald-700 font-semibold tabular-nums">
                      AST −{repo.astReductionPct}%
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-900">{repo.repoName}</div>
                  <div className="text-xs text-slate-600 font-mono">
                    {repo.detectedLanguage} · {repo.packageManager}
                  </div>
                  <div className="text-xs text-slate-500 tabular-nums">
                    {repo.sourceFileCount}{' '}
                    {repo.sourceFileCount === 1
                      ? 'файл'
                      : repo.sourceFileCount < 5
                      ? 'файла'
                      : 'файлов'}{' '}
                    · {repo.changes.length} OpenSpec{' '}
                    {repo.changes.length === 1 ? 'change' : 'changes'}
                  </div>
                </button>
              );
            })}
          </div>

          {activeRepo && (
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold text-slate-900">
                    Обнаруженная конфигурация
                  </h2>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                    0 правок ядра
                  </span>
                </div>

                <dl className="divide-y divide-slate-100 text-xs">
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Путь на диске</dt>
                    <dd className="font-mono font-semibold text-slate-900">{activeRepo.repoPath}</dd>
                  </div>
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Манифест</dt>
                    <dd className="font-mono font-semibold text-slate-900">{activeRepo.manifestFile}</dd>
                  </div>
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Язык и менеджер</dt>
                    <dd className="font-mono text-slate-900">
                      {activeRepo.detectedLanguage} ({activeRepo.packageManager})
                    </dd>
                  </div>
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Test Runner (Gate)</dt>
                    <dd className="font-mono text-slate-900 text-right">{activeRepo.testCommand}</dd>
                  </div>
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Линтер / Компилятор</dt>
                    <dd className="font-mono text-slate-900 text-right">{activeRepo.lintCommand}</dd>
                  </div>
                  <div className="py-2.5 flex justify-between gap-4">
                    <dt className="text-slate-500">Маркер трассировки</dt>
                    <dd className="font-mono text-blue-700">{activeRepo.specMarkerSyntax}</dd>
                  </div>
                </dl>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-slate-700">
                    Реальный файл {activeRepo.repoPath}/{activeRepo.manifestFile}
                  </div>
                  <pre className="bg-slate-900 text-slate-200 rounded-lg p-3.5 text-xs font-mono overflow-x-auto max-h-56 leading-relaxed">
                    {activeRepo.manifestContent}
                  </pre>
                </div>
              </div>

              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-slate-900">
                    AST-LOD1 скелет с диска ({activeRepo.sampleFilePath})
                  </h2>
                  <span className="text-xs font-mono text-emerald-700 font-semibold tabular-nums">
                    {activeRepo.rawTokens} → {activeRepo.skeletonTokens} ток. (−
                    {activeRepo.astReductionPct}%)
                  </span>
                </div>

                <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[420px] leading-relaxed">
                  {activeRepo.astSkeletonPreview}
                </pre>
              </div>
            </section>
          )}
        </>
      )}

      {/* Interactive Manifest Probe Tester */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Проверить автоопределение на произвольном манифесте
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Вставьте содержимое package.json, pyproject.toml, go.mod или pom.xml для проверки детектора
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
                    e.target.value as 'package.json' | 'pyproject.toml' | 'go.mod' | 'pom.xml'
                  )
                }
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-mono bg-white text-slate-900"
              >
                <option value="package.json">package.json</option>
                <option value="pyproject.toml">pyproject.toml</option>
                <option value="go.mod">go.mod</option>
                <option value="pom.xml">pom.xml</option>
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
