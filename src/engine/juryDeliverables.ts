import { AbRunReport } from './provenance';

export interface JuryDeliverablesBundle {
  reportMd: string;
  reproducibilityMd: string;
  demoScriptMd: string;
  pitchSlidesMd: string;
  openCodePluginTs: string;
  agentsMdSnippet: string;
}

function formatSavingsPct(val: number | null): string {
  if (val === null) return 'n/a';
  if (val > 0) return `−${val}%`;
  if (val < 0) return `+${Math.abs(val)}%`;
  return '0%';
}

export function generateJuryDeliverables(report: AbRunReport): JuryDeliverablesBundle {
  const { manifest, baseline, optimized, savings, provenance, limitations } = report;
  const isoLabel =
    manifest.isolationMode === 'snapshot_copy'
      ? 'snapshot_copy (идентичные копии снимка)'
      : 'git worktree';
  const provBadge =
    provenance === 'measured'
      ? `MEASURED · Счётчики облачного API и ${isoLabel}`
      : provenance === 'measured_local'
        ? `MEASURED_LOCAL · Локальные счётчики или проверки и ${isoLabel}`
        : 'SIMULATED / DEMO FIXTURE · Демонстрационные данные';

  const stageRows = baseline.stages
    .map((bs, idx) => {
      const os = optimized.stages[idx];
      const deltaPct =
        bs.totalTokens > 0
          ? Number((((bs.totalTokens - os.totalTokens) / bs.totalTokens) * 100).toFixed(1))
          : 0;
      return `| ${bs.stageLabel} | ${bs.totalTokens.toLocaleString('ru-RU')} | ${os.totalTokens.toLocaleString('ru-RU')} | **${formatSavingsPct(deltaPct)}** | ${os.cachedInputTokens.toLocaleString('ru-RU')} | ${os.durationMs} мс | ${bs.provenance} |`;
    })
    .join('\n');

  const baseRefLine =
    manifest.isolationMode === 'snapshot_copy'
      ? `- **Isolation Mode / Snapshot SHA-256:** \`snapshot_copy\` · \`${manifest.snapshotHash ?? manifest.baseCommit}\` (не Git commit)`
      : `- **Isolation Mode / Base Commit:** \`git_worktree\` · \`${manifest.baseCommit}\`${manifest.repoSubpath ? ` (subpath: \`${manifest.repoSubpath}\`)` : ''}`;

  const exit = (code: number | null | undefined) => code ?? '—';
  const reportMd = `# SpecTrim — Отчёт A/B-эксперимента SDD

> **Достоверность данных (Provenance):** \`${provBadge}\`
${limitations.length > 0 ? `\n**Ограничения замера:**\n${limitations.map((l) => `- ${l}`).join('\n')}\n` : ''}
## 1. Условия запуска (Run Manifest)

- **Run ID:** \`${manifest.runId}\`
- **Репозиторий / Change ID:** \`${manifest.repoName}\` / \`${manifest.changeId}\`
${baseRefLine}
- **Запрошенные провайдер и модель для A и B:** \`${manifest.provider}\` / \`${manifest.model}\`
- **Язык и команды проверки:** \`${manifest.detectedLanguage}\` · \`${manifest.testCommand}\` · \`${manifest.lintCommand}\`

## 2. Сводка Before / After

| Метрика | Baseline | SpecTrim (Optimized) | Изменение | Provenance |
| --- | ---: | ---: | ---: | --- |
| **Всего токенов** | ${baseline.totalTokens.toLocaleString('ru-RU')} | ${optimized.totalTokens.toLocaleString('ru-RU')} | **${formatSavingsPct(savings.totalTokensPct)}** | \`${provenance}\` |
| **Prompt / Input токены** | ${baseline.promptTokens.toLocaleString('ru-RU')} | ${optimized.promptTokens.toLocaleString('ru-RU')} | **${formatSavingsPct(savings.promptTokensPct)}** | \`${provenance}\` |
| **Cached Input токены** | ${baseline.cachedInputTokens.toLocaleString('ru-RU')} | ${optimized.cachedInputTokens.toLocaleString('ru-RU')} | cache measured: \`${optimized.cacheUsageMeasured}\` | \`${provenance}\` |
| **Completion / Output токены** | ${baseline.completionTokens.toLocaleString('ru-RU')} | ${optimized.completionTokens.toLocaleString('ru-RU')} | **${formatSavingsPct(savings.completionTokensPct)}** | \`${provenance}\` |
| **Расчётная стоимость ($)** | ${baseline.costUsd !== null ? `$${baseline.costUsd.toFixed(4)}` : 'n/a'} | ${optimized.costUsd !== null ? `$${optimized.costUsd.toFixed(4)}` : 'n/a'} | **${formatSavingsPct(savings.costPct)}** | \`estimated\` |
| **Вызовы инструментов модели / повторы** | ${baseline.toolCalls} / ${baseline.retries} | ${optimized.toolCalls} / ${optimized.retries} | retries: ${savings.retriesDelta >= 0 ? `−${savings.retriesDelta}` : `+${Math.abs(savings.retriesDelta)}`} | \`${provenance}\` |
| **Итерации LLM-ревью** | ${baseline.reviewIterations} | ${optimized.reviewIterations} | **${savings.reviewIterationsDelta >= 0 ? `−${savings.reviewIterationsDelta}` : `+${Math.abs(savings.reviewIterationsDelta)}`}** | \`${provenance}\` |
| **Сумма длительностей запросов к модели** | ${(baseline.durationMs / 1000).toFixed(2)} с | ${(optimized.durationMs / 1000).toFixed(2)} с | ${savings.durationDeltaMs >= 0 ? `−${(savings.durationDeltaMs / 1000).toFixed(2)} с` : `+${(Math.abs(savings.durationDeltaMs) / 1000).toFixed(2)} с`} | \`${provenance}\` |

## 3. Токены по стадиям SDD

| Стадия | Baseline (ток.) | SpecTrim (ток.) | Разница | Cached Input | Время (SpecTrim) | Provenance |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${stageRows}

## 4. Автоматическая проверка качества (Acceptance Criteria)

- **Задачи выполнена/всего:** Baseline \`${baseline.tasksCompleted}/${baseline.tasksTotal}\` · SpecTrim \`${optimized.tasksCompleted}/${optimized.tasksTotal}\`
- **Трассировка требований по маркерам (\`@spec:REQ-XX\`):** Baseline **${baseline.reqCoveragePct}%** · SpecTrim **${optimized.reqCoveragePct}%**
- **Тесты:** Baseline \`${baseline.testsPassed ? 'PASS' : 'FAIL'}\` (${baseline.testsOutputSummary}) · SpecTrim \`${optimized.testsPassed ? 'PASS' : 'FAIL'}\` (${optimized.testsOutputSummary})
- **Типизация и линтер:** Baseline \`${baseline.lintPassed ? 'PASS' : 'FAIL'}\` · SpecTrim \`${optimized.lintPassed ? 'PASS' : 'FAIL'}\`
- **Согласованность \`specs ↔ design ↔ tasks\`:** Baseline \`${baseline.artifactConsistency}\` · SpecTrim \`${optimized.artifactConsistency}\`
- **Коды выхода тестов, типизации и независимых тестов:** Baseline ${exit(baseline.testExitCode)} / ${exit(baseline.lintExitCode)} / ${exit(baseline.acceptanceExitCode)} · SpecTrim ${exit(optimized.testExitCode)} / ${exit(optimized.lintExitCode)} / ${exit(optimized.acceptanceExitCode)}
- **Quality Parity:** \`${report.qualityParityPassed ? 'PASS' : 'FAIL'}\`
`;

  const reproducibilityMd = `# Воспроизводимость и запуск SpecTrim CLI / A/B Benchmark

## 1. Требования к окружению
- Node.js >= 22.12, \`git\`, \`python3\` (для Python-полигона)
- Провайдер моделей для реального A/B-прогона (строго один и тот же для Baseline и SpecTrim):
  - **Основной облачный флагман**: \`GEMINI_API_KEY\` в \`.env\` или Settings > Secrets (модель по умолчанию \`gemini-4-hydrogen\`)
  - **Опционально локально без API-ключа**: установленная **Ollama** (\`ollama serve\` + \`ollama pull qwen2.5-coder:7b\`, адрес \`OLLAMA_BASE_URL=http://127.0.0.1:11434\`)
  - **Опционально OpenAI-compatible**: \`OPENAI_COMPAT_BASE_URL\` + \`OPENAI_COMPAT_API_KEY\` + \`OPENAI_COMPAT_MODEL\`

## 2. Запуск CLI поверх любого репозитория

\`\`\`bash
# 0. Проверка готовности провайдеров (Gemini / Ollama) и доступных полигонов
npm run spectrim -- status

# 1. Автоопределение стека и команд по манифесту
npm run spectrim -- detect benchmarks/orders-ts
npm run spectrim -- detect benchmarks/orders-py
npm run spectrim -- detect benchmarks/edge-go
npm run spectrim -- detect benchmarks/billing-java

# 2. Инспекция графа трассировки OpenSpec change
npm run spectrim -- inspect benchmarks/orders-ts add-rate-limit-and-audit

# 3. Извлечение task-scoped среза спеки + State Capsule
npm run spectrim -- slice benchmarks/orders-ts add-rate-limit-and-audit --task TSK-07

# 4. Запуск Zero-Token Pre-Review Gate (реальные тесты + tsc/lint + @spec:REQ-XX + консистентность)
npm run spectrim -- gate benchmarks/orders-ts add-rate-limit-and-audit

# 5a. Облачный A/B worktree-прогон (основной флагман Gemini Hydrogen)
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider gemini --model gemini-4-hydrogen

# 5b. Локальный A/B worktree-прогон через Ollama (без API-ключа)
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider ollama --model qwen2.5-coder:7b
\`\`\`

## 3. Артефакты воспроизводимого запуска
Каждый прогон сохраняется в \`.spectrim-runs/<runId>/\`:
- \`run_manifest.json\` — Git SHA или SHA-256 проверенного снимка, провайдер, модель и команды проверок
- \`metrics.jsonl\` — телеметрия ответов с исходными счётчиками провайдера и \`provenance\` (\`measured\` / \`measured_local\`)
- \`baseline.diff\` и \`optimized.diff\` — diff обеих изолированных копий
- \`checks.jsonl\` — команды проверок, полный stdout/stderr и коды выхода обеих сторон
- \`provider-attempts.jsonl\` — попытки вызова провайдера, включая сбои
- \`summary.json\` и \`REPORT.md\` — сводные таблицы и проверка acceptance criteria
`;

  const demoScriptMd = `# Сценарий видео-демонстрации (3:30)

1. **0:00–0:35 · Реальный репозиторий и постановка**: показать \`benchmarks/orders-ts/openspec/changes/add-idempotency-and-webhooks/\` и \`run_manifest.json\` (Git SHA или SHA-256 снимка, общие модель и провайдер для A и B).
2. **0:35–1:30 · Изолированный прогон A/B**: запуск \`spectrim bench\` или кнопки в UI, просмотр реальных событий в \`metrics.jsonl\` с \`provenance: measured\`, сравнение \`baseline.diff\` и \`optimized.diff\`.
3. **1:30–2:30 · Разбор 5 механизмов в действии**: Spec Slicer + State Capsule, AST-LOD1, Hashline-патч (и отказ на устаревшем хэше), сжатие TAP/pytest/git diff, Zero-Token Pre-Review Gate с реальным запуском \`node --import tsx --test\` и \`tsc --noEmit\`.
4. **2:30–3:10 · Портативность**: \`spectrim detect\` на TypeScript (\`package.json\`), Python (\`pyproject.toml\` + \`unittest\`), Go (\`go.mod\`) и Java (\`pom.xml\`).
5. **3:10–3:30 · Итог**: таблица Before/After из \`REPORT.md\`, фактические результаты тестов и Quality Parity обеих сторон.
`;

  const pitchSlidesMd = `# Презентация SpecTrim (7 слайдов)

1. **Проблема**: $O(N^2)$ рост контекста, повторное чтение спеки/кода и слепые циклы ревью в \`OpenCode + OpenSpec\`.
2. **Ограничения**: общие модель и постановка, исходные требования и независимые проверки.
3. **Архитектура**: Spec Slicer + State Capsule, AST-LOD + Hashline, Diff/Log Compressor, Zero-Token Pre-Review Gate, Delta Review + KV-Cache порядок.
4. **Доказательная база A/B**: общий Git SHA или SHA-256 снимка, исходная телеметрия, коды выхода, независимые проверки.
5. **Проверка качества**: фактические тесты и типизация у каждой стороны, трассировка и независимая проверка требований.
6. **Портативность**: автодетект TS/JS, Python, Go, Java по манифестам без правки ядра.
7. **Артефакты**: \`REPORT.md\`, \`run_manifest.json\`, \`.opencode/plugins/spectrim.ts\`.
`;

  const openCodePluginTs = `// .opencode/plugins/spectrim.ts — OpenCode Plugin Hook
import { sliceSpecForTask } from '../../src/engine/specSlicer';
import { renderAstLodView, applyHashlinePatch } from '../../src/engine/astLodHashline';
import { compressTestLog, compressGitDiff } from '../../src/engine/outputCompressor';
import { runLocalPreReviewGate } from '../../src/runtime/localGateRunner';

export const specTrimPlugin = {
  name: 'spectrim-sdd',
  async beforeTask(ctx: { bundle: any; taskId: string; completedTaskIds: string[] }) {
    return sliceSpecForTask(ctx.bundle, ctx.taskId, ctx.completedTaskIds);
  },
  async readContext(ctx: { filePath: string; content: string; language: any; isTarget: boolean }) {
    return renderAstLodView(ctx.filePath, ctx.content, ctx.language, ctx.isTarget ? 'LOD0' : 'LOD1');
  },
  async compressToolOutput(ctx: { command: string; stdout: string }) {
    if (/test|pytest|vitest|jest|unittest/.test(ctx.command)) return compressTestLog(ctx.stdout).compressed;
    if (ctx.command.startsWith('git diff')) return compressGitDiff(ctx.stdout).compressed;
    return ctx.stdout;
  },
  async beforeReview(ctx: { repoPath: string; changeId: string }) {
    return runLocalPreReviewGate(ctx.repoPath, ctx.changeId);
  },
  applyHashlinePatch,
};
`;

  const agentsMdSnippet = `# AGENTS.md — SpecTrim SDD Workflow Policy

1. Для каждой задачи \`TSK-XX\` работай в изолированной сессии и запрашивай срез спеки через \`spectrim slice <repo> <changeId> --task TSK-XX\`.
2. Читай целевые файлы в формате Hashline (\`LOD0\`), а смежные зависимости — в формате AST-скелета (\`LOD1\`).
3. Используй Hashline range-патчи (\`L{start}#{hash}..L{end}#{hash}\`) вместо переписывания файлов целиком.
4. Маркируй реализацию и тесты комментариями \`@spec:REQ-XX\`.
5. Перед вызовом LLM-ревьюера запускай \`spectrim gate <repo> <changeId>\` (0 токенов).
`;

  return {
    reportMd,
    reproducibilityMd,
    demoScriptMd,
    pitchSlidesMd,
    openCodePluginTs,
    agentsMdSnippet,
  };
}
