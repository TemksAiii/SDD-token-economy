# SpecTrim: Запуск и воспроизводимость

## 1. Архитектура и модули
- `src/engine/` — чистые детерминированные модули: `specSlicer.ts`, `astLodHashline.ts`, `outputCompressor.ts`, `preReviewGate.ts`, `portability.ts`, `provenance.ts`, `abModelSimulation.ts`.
- `src/runtime/` — работа с диском и процессом: `repoFs.ts`, `localGateRunner.ts`, `llmProvider.ts`, `abWorktreeRunner.ts`, `pathGuard.ts`.
- `bin/spectrim.ts` — CLI для интеграции в `OpenCode` и `OpenSpec`.
- `benchmarks/` — реальные полигоны на TypeScript (`orders-ts`), Python (`orders-py`), Go (`edge-go`) и Java (`billing-java`).

## 2. Достоверность данных (Data Provenance)
Каждая метрика и отчёт строго маркируются:
- `measured` — получены из реального прогона `git worktree` + `usageMetadata` API провайдера + реальных тестов и `git diff`.
- `measured_local` — реальный запуск тестов, линтера, `git`, подсчёт AST/срезов на диске без вызова внешнего LLM API.
- `estimated` — оценка токенизации текста без ответа провайдера.
- `simulated` / `demo_fixture` — локальная математическая симуляция или fixture-пример; никогда не выдаётся за `measured`.

## 3. Команды проверки
```bash
npm run lint
npm test
npm run build
npm run spectrim -- detect benchmarks/orders-ts
npm run spectrim -- gate benchmarks/orders-ts add-rate-limit-and-audit
npm run spectrim -- bench benchmarks/orders-ts add-idempotency-and-webhooks --model gemini-4-hydrogen
```
