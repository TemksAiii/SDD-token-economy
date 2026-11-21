# Design: Idempotency Guard & Webhook Signer

## [DES-01] IdempotencyGuard In-Memory Store
Linked requirements: REQ-01, REQ-02, REQ-03
Модуль `src/idempotency/idempotencyGuard.ts`: класс `IdempotencyConflictError` и класс `IdempotencyGuard` с методом `execute<T>(key, payload, fn, nowMs)`.

## [DES-02] HMAC-SHA256 Webhook Signer & Verifier
Linked requirements: REQ-04, REQ-05
Модуль `src/webhooks/webhookSigner.ts`: функции `signWebhookPayload(secret, timestampSec, body)` и `verifyWebhookSignature(secret, signatureHeader, body, nowSec, maxAgeSec)`.

## [DES-03] Webhook Retry Backoff Scheduler
Linked requirements: REQ-06
Модуль `src/webhooks/webhookSigner.ts`: функция `computeRetryDelayMs(attempt, baseMs = 1000, maxMs = 60000)`.

## [DES-04] Unit Test Suite for Idempotency & Webhooks
Linked requirements: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06
Тесты в `tests/idempotency_webhooks.test.ts` на `node:test` с маркерами `@spec:REQ-01..REQ-06`.
