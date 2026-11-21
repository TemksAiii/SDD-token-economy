# Architecture & Design: Rate Limiting + Audit Log

## [DES-01] Token Bucket Store & Quota Resolution
Linked requirements: REQ-01, REQ-02, REQ-05
Класс `TokenBucketRateLimiter` в `src/middleware/rateLimiter.ts` с методом `consume(path, apiKey, ip, nowMs)`.

## [DES-02] Bypass & HTTP 429 Response Headers
Linked requirements: REQ-02, REQ-03, REQ-04
`BYPASS_PATHS = Set(['/healthz', '/metrics'])`, возврат заголовков `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`.

## [DES-03] AuditEvent & PII Redactor
Linked requirements: REQ-06, REQ-07
Функция `redactPayload(data)` в `src/audit/auditLogger.ts` с маскированием секретных полей и расчётом SHA-256 `requestHash`.

## [DES-04] Buffered AuditDispatcher & NDJSON Spool Fallback
Linked requirements: REQ-08, REQ-09
`AuditDispatcher.flushOnce()` в `src/audit/auditLogger.ts` с резервной записью в NDJSON spool-файл при сбое `primarySink`.

## [DES-05] Admin Audit Query Router & RBAC Guard
Linked requirements: REQ-10
Функция `queryAuditTrail(events, params)` в `src/routes/auditRouter.ts` с проверкой роли `security_admin`.

## [DES-06] Verification & Concurrency Test Harness
Linked requirements: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10
Набор тестов `tests/rate_limit_audit.test.ts` на `node:test`.
