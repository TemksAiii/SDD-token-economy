# SpecTrim: Запуск и воспроизводимость

## 1. Архитектура и модули
- `src/engine/` — чистые детерминированные модули: `specSlicer.ts`, `astLodHashline.ts`, `outputCompressor.ts`, `preReviewGate.ts`, `portability.ts`, `provenance.ts`, `abModelSimulation.ts`.
- `src/runtime/` — работа с диском и процессом: `repoFs.ts`, `localGateRunner.ts`, `llmProvider.ts`, `abWorktreeRunner.ts`, `pathGuard.ts`.
- `bin/spectrim.ts` — CLI для интеграции в `OpenCode` и `OpenSpec`.
- `benchmarks/` — реальные полигоны на TypeScript (`orders-ts`), Python (`orders-py`), Go (`edge-go`) и Java (`billing-java`).

## 2. Достоверность данных (Data Provenance)
Каждая метрика и отчёт строго маркируются:
- `measured` — счётчики облачного API, например Gemini `usageMetadata`.
- `measured_local` — локальные проверки и счётчики локального инференса Ollama (`prompt_eval_count`, `eval_count`).
- `estimated` — оценка токенизации текста без ответа провайдера.
- `simulated` / `demo_fixture` — локальная математическая симуляция или fixture-пример; никогда не выдаётся за `measured`.

## 3. Команды проверки
```bash
npm run lint
npm test
npm run build
npm run spectrim -- status
npm run spectrim -- detect benchmarks/orders-ts
npm run spectrim -- gate benchmarks/orders-ts add-rate-limit-and-audit

# Облачный флагман (нужен GEMINI_API_KEY)
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider gemini --model gemini-4-hydrogen

# Локальный запуск через Ollama (без API-ключа)
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --provider ollama --model qwen2.5-coder:7b
```

## 4. Изоляция и артефакты A/B

- Git доступен через CLI. SpecTrim находит корень через `git rev-parse`, создаёт два detached worktree от одного Git SHA и выполняет команды из подкаталога полигона.
- Если worktree недоступны или дерево Git расходится с исходным каталогом, SpecTrim делает один снимок и две копии. Их SHA-256 сравниваются до обращения к модели. У снимка `baseCommit: null`. В manifest записываются причина выбора, SHA-256 и правила построения.
- Формат `spectrim-tree-v2` хэширует отсортированные относительные пути каталогов и обычных файлов, режим исполнения, длину и байты файлов. Исключаются Git-метаданные, кэши, зависимости, выходные каталоги, локальные `.env` (кроме примера) и символические ссылки. Полный перечень имён хранится в manifest. Git нужен для сохранения diff и в режиме снимка.
- `metrics.jsonl` хранит исходные счётчики каждого успешного ответа, `provider-attempts.jsonl` — все попытки, `checks.jsonl` — полные результаты тестов, типизации и независимой проверки. При неизвестном расходе любой попытки или расхождении возвращённых версий модели проценты экономии токенов и стоимости остаются пустыми. Стоимость рассчитывается по локальной таблице тарифов.
- В полигоне `orders-ts` обычные тесты запускает Node Test Runner с загрузчиком `tsx`, а типизацию — `tsc --noEmit`. Для `add-idempotency-and-webhooks` один набор из семи независимых проверок запускается для A и B. Для подтверждения Quality Parity у других OpenSpec changes потребуется свой набор.
- TS/JS и TSX/JSX используют AST. Python, Go и Java используют построчные обзоры. Для некорректного TS/JS или пустого извлечения доступен полный текст с якорями.
