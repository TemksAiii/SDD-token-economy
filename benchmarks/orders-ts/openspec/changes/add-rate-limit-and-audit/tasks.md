# Implementation Tasks

- [x] [TSK-01] Реализовать `TokenBucketRateLimiter` и бакеты по API-ключу в `src/middleware/rateLimiter.ts` (REQ-01, REQ-05, DES-01)
- [x] [TSK-02] Добавить IP fallback для анонимных клиентов в `src/middleware/rateLimiter.ts` (REQ-02, DES-01, DES-02)
- [x] [TSK-03] Реализовать HTTP 429 и заголовки `Retry-After` в `src/middleware/rateLimiter.ts` (REQ-03, DES-02)
- [x] [TSK-04] Добавить whitelist-исключения `/healthz` и `/metrics` в `src/middleware/rateLimiter.ts` (REQ-04, DES-02)
- [x] [TSK-05] Реализовать `redactPayload` и создание `AuditEvent` в `src/audit/auditLogger.ts` (REQ-06, REQ-07, DES-03)
- [x] [TSK-06] Реализовать батчевый сброс `AuditDispatcher.flushOnce()` в `src/audit/auditLogger.ts` (REQ-08, DES-04)
- [x] [TSK-07] Реализовать NDJSON spool fallback при сбое sink в `src/audit/auditLogger.ts` (REQ-09, DES-04)
- [x] [TSK-08] Реализовать `queryAuditTrail` с проверкой роли `security_admin` в `src/routes/auditRouter.ts` (REQ-10, DES-05)
- [x] [TSK-09] Покрыть `REQ-01..REQ-05` тестами в `tests/rate_limit_audit.test.ts` (REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, DES-06)
- [x] [TSK-10] Покрыть `REQ-06..REQ-10` тестами в `tests/rate_limit_audit.test.ts` (REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, DES-06)
