# Idempotency & Webhook Signing Specification

### [REQ-01] Idempotency Key Replay Returns Cached Result
Given повторный запрос с тем же `idempotencyKey` и тем же хэшем payload
When вызывается `IdempotencyGuard.execute(key, payloadHash, handler)`
Then возвращается сохранённый результат без повторного вызова `handler`.

### [REQ-02] Payload Mismatch Rejects Reused Idempotency Key
Given запрос с тем же `idempotencyKey`, но другим `payloadHash`
When вызывается `IdempotencyGuard.execute(key, payloadHash, handler)`
Then выбрасывается ошибка конфликта `IdempotencyConflictError`.

### [REQ-03] TTL Expiration Clears Stale Idempotency Records
Given запись старше `ttlMs`
When поступает запрос с тем же `idempotencyKey`
Then запись считается истекшей и `handler` выполняется заново.

### [REQ-04] Deterministic HMAC-SHA256 Webhook Signature
Given событие заказа и секрет подписчика
When вызывается `signWebhookPayload(secret, timestampSec, body)`
Then формируется заголовок вида `t=<timestampSec>,v1=<hex_hmac_sha256>`.

### [REQ-05] Constant-Time Webhook Signature Verification
Given входящий webhook payload, заголовок подписи и допустимое окно `maxAgeSec`
When вызывается `verifyWebhookSignature(secret, header, body, nowSec, maxAgeSec)`
Then возвращается `true` только при валидной подписи и неистёкшем timestamp (через `crypto.timingSafeEqual`).

### [REQ-06] Exponential Backoff Schedule for Webhook Retries
Given номер попытки `attempt` (1..5)
When вычисляется задержка следующей попытки `computeRetryDelayMs(attempt, baseMs)`
Then возвращается `baseMs * 2^(attempt - 1)` с ограничением максимума `60000` мс.
