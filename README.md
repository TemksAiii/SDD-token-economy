# SpecTrim SDD Workbench

Инженерная система и интерактивный стенд для снижения расхода токенов в **Spec-Driven Development (SDD / OpenSpec)** при сохранении качества: 100% покрытие требований `@spec:REQ-XX` в коде и тестах, проходящие тесты и линтер, согласованность `proposal / specs / design / tasks`, а также **одинаковая модель и провайдер** для Baseline и SpecTrim внутри каждого A/B-эксперимента.

Веб-интерфейс и API работают на Express + Vite (порт `3000`), а CLI `spectrim` позволяет запускать все проверки и изолированные `git worktree` A/B-прогоны прямо из терминала.

---

## Что работает без внешнего LLM-ключа, а что требует модель

| Режим | Что выполняется | Нужен ли LLM / API-ключ | Provenance |
| --- | --- | --- | --- |
| **Инспекция OpenSpec, Spec Slicer, AST-LOD & Hashline, Zero-Token Gate, Портативность** | Чтение реальных файлов в `benchmarks/*`, построение AST-скелетов, запуск реальных тестов (`tsx --test`, `tsc --noEmit`, `python3 -m unittest`) и `git` | **Нет** | `measured_local` |
| **Математическая симуляция и Ablation Study** | Расчётная модель $O(N^2) \to O(N)$ по настраиваемым параметрам (K задач, R ревью, тумблеры модулей) | **Нет** | `simulated` |
| **Реальный A/B worktree-прогон с облачным флагманом Gemini** | Два изолированных `git worktree` от одного commit SHA, Baseline vs SpecTrim на **Gemini Hydrogen** (`gemini-4-hydrogen`), реальный `usageMetadata` | Нужен `GEMINI_API_KEY` | `measured` |
| **Реальный A/B worktree-прогон локально через Ollama** | Два изолированных `git worktree` от одного commit SHA, Baseline vs SpecTrim на локальной модели (например `qwen2.5-coder:7b`), счётчики `prompt_eval_count` / `eval_count` | **API-ключ не нужен** (нужна локальная Ollama) | `measured` |

---

## 1. Системные требования и зависимости

Обязательные инструменты:
- **Node.js** `>= 22.12`
- **npm** `>= 10`
- **Git** (обязателен для A/B-сравнения через `git worktree`)

Опционально:
- **Python 3** — для запуска реальных `unittest`-проверок полигона `benchmarks/orders-py`
- **Go / Maven** — для запуска тестов Go/Java-проектов (автодетект манифестов и AST-LOD работают и без них)
- **Ollama** — для локальных A/B-замеров без облачного API-ключа

Проверка версий в терминале:

```bash
node --version
npm --version
git --version
python3 --version
```

Установка npm-зависимостей (используйте `npm install`, lockfile в репозитории не зафиксирован):

```bash
npm install
```

---

## 2. Настройка `.env` и провайдеров

Сервер (`server.ts`) и CLI (`bin/spectrim.ts`) автоматически загружают `.env` через `dotenv/config`. Создайте локальный `.env` из шаблона:

```bash
# Linux / macOS
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

Содержимое `.env.example`:

```dotenv
# Основной облачный флагман для жюри (Gemini Hydrogen)
GEMINI_API_KEY="MY_GEMINI_API_KEY"
APP_URL="http://localhost:3000"

# Опциональный локальный провайдер Ollama (API-ключ не требуется)
OLLAMA_ENABLED="true"
OLLAMA_BASE_URL="http://127.0.0.1:11434"
OLLAMA_MODEL="qwen2.5-coder:7b"

# Опциональный OpenAI-compatible endpoint (OpenCode / vLLM / OpenRouter)
OPENAI_COMPAT_BASE_URL=
OPENAI_COMPAT_API_KEY=
OPENAI_COMPAT_MODEL=
```

### Вариант A: Основной облачный флагман — Gemini Hydrogen

Для эталонного облачного A/B-прогона с `gemini-4-hydrogen` (или быстрой `gemini-3.1-flash-lite`):
1. Укажите `GEMINI_API_KEY="ваш_ключ"` в `.env` (либо в Google AI Studio: **Settings → Secrets**).
2. При наличии `GEMINI_API_KEY` провайдер `gemini` и модель `gemini-4-hydrogen` автоматически выбираются по умолчанию.

### Вариант B: Локальная проверка без API-ключа — Ollama

Если облачного ключа нет или вы хотите воспроизвести реальный worktree A/B-прогон полностью локально:

1. **Установите Ollama**: https://ollama.com/download
2. **Запустите сервис Ollama** (если не запущен как фоновая служба):
   ```bash
   ollama serve
   ```
3. **Скачайте локальную coding-модель** (рекомендуемый старт для ноутбуков с 8–16 ГБ RAM):
   ```bash
   ollama pull qwen2.5-coder:7b
   ```
4. **Проверьте, что модель доступна**:
   ```bash
   ollama list
   curl http://127.0.0.1:11434/api/tags
   ```
   В Windows PowerShell вместо `curl`:
   ```powershell
   Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags"
   ```
5. **Проверьте, что SpecTrim видит Ollama**:
   ```bash
   npm run spectrim -- status
   ```
   При активной Ollama (`http://127.0.0.1:11434`) и загруженной модели `qwen2.5-coder:7b` в выводе появится `"ollamaConfigured": true` и список установленных моделей. **Никакой фиктивный API-ключ для Ollama не нужен.**

---

## 3. Локальный запуск веб-приложения

### Режим разработки

```bash
npm run dev
```

Откройте в браузере:
- Приложение: `http://localhost:3000`
- Проверка здоровья сервера: `http://localhost:3000/api/health` (ожидается `{"status":"ok","service":"spectrim-sdd-workbench"}`)

### Production-сборка и запуск

Linux / macOS:
```bash
npm run build
NODE_ENV=production npm start
```

Windows PowerShell:
```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

Windows Command Prompt:
```bat
npm run build
set NODE_ENV=production
npm start
```

---

## 4. Запуск A/B-бенчмарка: через UI и через CLI

### Через веб-интерфейс (`http://localhost:3000`)

1. Откройте вкладку **«Обзор A/B»**.
2. В блоке **«Реальный A/B-прогон в изолированных git worktree»** выберите:
   - **Git-репозиторий** (например, `benchmarks/orders-ts`)
   - **OpenSpec Change** (например, `add-idempotency-and-webhooks` — 8 невыполненных задач)
   - **Провайдер (A и B)**: `gemini` (облачный флагман) или `ollama` (локально без API-ключа)
   - **Единая модель (A и B)**: например `gemini-4-hydrogen` или `qwen2.5-coder:7b` (если Ollama запущена после открытия страницы, нажмите **«Обновить статус»**)
   - **Итераций ревью (Baseline)** (1–5)
3. Нажмите **«Запустить реальный worktree A/B»**. Прогресс транслируется по SSE, а по завершении отчёт автоматически переключается в режим **«Реальный A/B»** (`provenance: measured`).
4. Нажмите на вкладку **«Отчёт жюри»**, чтобы просмотреть и скачать `REPORT.md`, `run_manifest.json`, `metrics.jsonl` и `baseline.diff` / `optimized.diff`.

### Через CLI (`npm run spectrim -- ...`)

```bash
# Проверить готовность провайдеров (Gemini / Ollama) и найденные полигоны
npm run spectrim -- status

# Автоопределение стека и команд тестирования по манифесту
npm run spectrim -- detect benchmarks/orders-ts
npm run spectrim -- detect benchmarks/orders-py
npm run spectrim -- detect benchmarks/edge-go
npm run spectrim -- detect benchmarks/billing-java

# Инспекция OpenSpec-графа REQ -> DES -> TSK
npm run spectrim -- inspect benchmarks/orders-ts add-rate-limit-and-audit

# Построение task-scoped среза спеки и State Capsule для конкретной задачи
npm run spectrim -- slice benchmarks/orders-ts add-rate-limit-and-audit --task TSK-07

# Запуск Zero-Token Pre-Review Gate (реальные тесты + tsc/lint + @spec:REQ-XX + консистентность)
npm run spectrim -- gate benchmarks/orders-ts add-rate-limit-and-audit

# Облачный A/B-прогон на основном флагмане Gemini Hydrogen
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider gemini --model gemini-4-hydrogen

# Локальный A/B-прогон через Ollama без API-ключа
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider ollama --model qwen2.5-coder:7b
```

Артефакты каждого реального прогона сохраняются на диск в `.spectrim-runs/<runId>/`:
- `run_manifest.json` — `baseCommit`, провайдер, единая модель, команды тестов/линтера, пути worktree
- `metrics.jsonl` — построчная телеметрия каждого вызова LLM с `provenance`
- `baseline.diff` и `optimized.diff` — реальные `git diff` из изолированных worktree
- `summary.json` и `REPORT.md` — сводная таблица Before/After и результаты проверок качества

### Какие метрики читать после прогона

- `promptTokens`, `completionTokens`, `totalTokens` — реальные счётчики токенов от провайдера (`usageMetadata` у Gemini или `prompt_eval_count` / `eval_count` у Ollama).
- `costUsd` — расчётная стоимость в USD по таблице тарифов (`gemini-4-hydrogen`, `gemini-3.1-flash-lite`); для локальной Ollama и неизвестных моделей честно выводится `n/a`.
- `cacheUsageMeasured` и `cachedInputTokens` — подтверждённый провайдером кэш промпта (для Ollama `false` / `0`, так как `/api/chat` не возвращает счётчик API-кэша).
- `testsPassed`, `lintPassed`, `reqCoveragePct`, `artifactConsistency` — реальная проверка качества в worktree.

---

## 5. Проверка проекта: тесты, типы и сборка

```bash
# Проверка типов TypeScript (tsc --noEmit)
npm run lint

# Все unit- и runtime-тесты движков и адаптеров провайдеров
npm test

# Production-сборка фронтенда (dist/)
npm run build
```

Тесты находятся в `src/engine/*.test.ts` и `src/runtime/*.test.ts` и проверяют:
- `specSlicer`, `astLodHashline` (TypeScript, Python, Go, Java), `outputCompressor`, `preReviewGate`, `portability`, `abModelSimulation`;
- `pathGuard`, `repoFs` (реальные полигоны в `benchmarks/`), `localGateRunner` (реальный запуск `tsx --test`, `tsc --noEmit` и `python3 -m unittest`);
- `llmProvider` (проверка схем URL, discovery `/api/tags`, разбор `prompt_eval_count`/`eval_count` в `/api/chat`, обработка 404, отказ от фабрикации отсутствующих счётчиков, корректный отказ при недоступном сервере).

---

## 6. Доступные HTTP API (`http://localhost:3000`)

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/health` | Проверка работоспособности сервера |
| `GET` | `/api/status` | Статус провайдеров (Gemini, Ollama `/api/tags`, OpenAI-compat), список git-полигонов и сохранённых прогонов |
| `POST` | `/api/simulation` | Пересчёт математической симуляции (`provenance: simulated`) |
| `GET` | `/api/fs/portability` | Реальный анализ манифестов и AST-сжатия на полигонах `benchmarks/*` |
| `GET` | `/api/fs/inspect` | Чтение и разбор графа OpenSpec с диска (`?repo=...&change=...`) |
| `POST` | `/api/fs/slice` | Task-scoped срез спеки и State Capsule по реальным файлам |
| `POST` | `/api/fs/ast-lod` | Построение `LOD0` (Hashline) / `LOD1` (AST-скелет) / `LOD2` по файлу на диске |
| `POST` | `/api/hashline-patch` | Применение range-патча с проверкой `L{n}#{hash}` |
| `POST` | `/api/compress` | Сжатие `git diff` или логов тестов |
| `POST` | `/api/fs/gate` | Запуск Zero-Token Pre-Review Gate поверх реального репозитория |
| `GET` | `/api/runs` | Список завершённых прогонов в `.spectrim-runs/` |
| `GET` | `/api/runs/:runId` | Загрузка `summary.json` и deliverables конкретного прогона |
| `POST` | `/api/runs/start` | Запуск изолированного A/B worktree-прогона (`{ repoPath, changeId, provider, model, maxReviewIters }`) |
| `GET` | `/api/runs/jobs/:jobId/stream` | SSE-поток прогресса выполняющегося A/B-прогона |
| `POST` | `/api/runs/jobs/:jobId/cancel` | Отмена активного A/B-прогона через `AbortController` |

---

## 7. Структура репозитория

```text
.
├── bin/
│   └── spectrim.ts              # CLI (status, detect, inspect, slice, gate, compress, bench)
├── benchmarks/
│   ├── orders-ts/               # Git-полигон TypeScript (node:test + tsc)
│   ├── orders-py/               # Git-полигон Python (unittest)
│   ├── edge-go/                 # Полигон Go (go.mod)
│   └── billing-java/            # Полигон Java (pom.xml)
├── docs/
│   └── REPRODUCIBILITY.md       # Краткая памятка по воспроизводимости и provenance
├── src/
│   ├── components/              # UI: Обзор A/B, Модули, Портативность, Отчёт жюри
│   ├── data/                    # Встроенные sample-фильтры логов/diff для Sandbox
│   ├── engine/                  # Детерминированные модули, симуляция, типы provenance
│   ├── runtime/                 # Безопасная работа с ФС, gate, llmProvider (Gemini/Ollama), worktree A/B
│   ├── types/                   # Контракты UI
│   ├── App.tsx
│   └── main.tsx
├── server.ts                    # Express-сервер, Vite middleware и REST/SSE API
├── AGENTS.md                    # Политика SDD-воркфлоу для агентов
├── .env.example
└── package.json
```

---

## 8. Достоверность данных (Provenance) и ограничения Ollama

В интерфейсе, JSON-отчётах и `REPORT.md` данные строго разделяются:
- **`measured` (облачный API, например `gemini-4-hydrogen`)**: реальные worktree + реальный `usageMetadata` API + реальные тесты и `git diff`.
- **`measured` (локальная `ollama`)**: реальные worktree + реальные `prompt_eval_count`/`eval_count` локального сервера + реальные тесты и `git diff`. **Важные ограничения локальных моделей Ollama**:
  1. `costUsd` всегда равен `n/a` (локальный инференс не имеет тарифа облачного API).
  2. `cacheUsageMeasured` равен `false` (`cachedInputTokens = 0`), так как Ollama `/api/chat` не отдаёт счётчик кэшированных токенов.
  3. Компактные локальные модели (например 7B–8B) могут чаще допускать ошибки формата JSON или недописывать `@spec:REQ-XX` — SpecTrim честно отразит это в `retries`, `testsPassed`, `lintPassed` и `reqCoveragePct` без подделки зелёных галочек. Для эталонного сравнения на жюри используйте облачный флагман `gemini-4-hydrogen`.
- **`measured_local`**: реальные измерения на диске (размер файлов, AST-срезы, выполнение тестов/линтера) без обращения к LLM.
- **`simulated`**: расчёт математической модели — наглядно иллюстрирует формулы $O(N^2) \to O(N)$, но не подменяет измеренный A/B-прогон.
- **`demo_fixture`**: встроенные образцы логов и диффов в песочнице модулей.

---

## 9. Решение типичных проблем

### Ollama не отвечает (`Ollama не отвечает по адресу http://127.0.0.1:11434`)
1. Убедитесь, что Ollama запущена: `ollama serve`.
2. Если Ollama работает на другом порту или хосте (например в Docker/WSL), укажите адрес в `.env`:
   ```dotenv
   OLLAMA_BASE_URL="http://127.0.0.1:11434"
   ```
3. Перезапустите `npm run dev` или нажмите **«Обновить статус»** в UI.

### Модель не найдена в Ollama (`Модель "..." не найдена в Ollama`)
1. Посмотрите список установленных моделей: `ollama list`.
2. Скачайте нужную модель: `ollama pull qwen2.5-coder:7b`.
3. Убедитесь, что имя модели вместе с тегом (`:7b` и т.д.) совпадает с выбранным в UI или переданным в `--model`.

### Ошибка провайдера Gemini (`GEMINI_API_KEY не задан`)
1. Для облачного A/B-прогона добавьте `GEMINI_API_KEY="..."` в `.env` и перезапустите сервер.
2. Либо переключите выпадающий список **«Провайдер (A и B)»** на `ollama` для бесплатного локального прогона без ключа.

### Порт `3000` занят
Найдите и остановите процесс, слушающий порт `3000`:
- Linux / macOS: `lsof -i :3000`
- Windows PowerShell: `Get-NetTCPConnection -LocalPort 3000 -State Listen`

### Прогон benchmark или Zero-Token Gate завершился с ошибкой качества (`FAIL`)
Это ожидаемое честное поведение, если тестируемая модель пропустила маркер `@spec:REQ-XX`, сломала синтаксис или не прошла тесты в worktree. Откройте вкладку **«Отчёт жюри» → `baseline.diff` / `optimized.diff`**, либо проверьте репозиторий вручную через `npm run spectrim -- gate <repo> <changeId>`.
