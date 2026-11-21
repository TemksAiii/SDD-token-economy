# Design: Idempotency Guard & Webhook Signer

## [DES-01] IdempotencyGuard In-Memory Store
Linked requirements: REQ-01, REQ-02, REQ-03
Модуль `src/idempotency/idempotencyGuard.ts`: класс `IdempotencyConflictError extends Error` и класс `IdempotencyGuard` (`constructor(ttlMs = 60_000)`) с методом `async execute<T>(key: string, payloadHash: string, handler: () => Promise<T> | T, nowMs: number = Date.now()): Promise<T>`.

## [DES-02] HMAC-SHA256 Webhook Signer & Verifier
Linked requirements: REQ-04, REQ-05
Модуль `src/webhooks/webhookSigner.ts`: функции `signWebhookPayload(secret: string, timestampSec: number, body: string): string` и `verifyWebhookSignature(secret: string, signatureHeader: string, body: string, nowSec: number, maxAgeSec: number): boolean` (с использованием `crypto.timingSafeEqual`).

## [DES-03] Webhook Retry Backoff Scheduler
Linked requirements: REQ-06
Модуль `src/webhooks/webhookSigner.ts`: функция `computeRetryDelayMs(attempt: number, baseMs = 1000, maxMs = 60_000): number`.

## [DES-04] Unit Test Suite for Idempotency & Webhooks
Linked requirements: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06
Тесты в `tests/idempotency_webhooks.test.ts` на `node:test` с маркерами `@spec:REQ-01..REQ-06`. Импорт модулей из `../src/idempotency/idempotencyGuard` и `../src/webhooks/webhookSigner`, проверка реальных вызовов handler (счётчик вызовов = 1 при повторе), конфликта payloadHash, истечения TTL, подписи HMAC-SHA256 и backoff.
