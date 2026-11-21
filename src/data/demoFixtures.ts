import { OpenSpecBundle } from '../engine/specSlicer';
import { GateSourceFile } from '../engine/preReviewGate';
import { DataProvenance } from '../engine/provenance';

/**
 * Sample fixtures explicitly tagged as demo_fixture (used only by unit tests
 * and quick-load log/diff compression examples in the sandbox).
 * Real project inspection, Gate checks, Portability, and A/B benchmarks read
 * directly from disk repositories under benchmarks/.
 */
export const FIXTURE_PROVENANCE: DataProvenance = 'demo_fixture';

export const DEMO_OPENSPEC_BUNDLE: OpenSpecBundle = {
  changeId: 'add-rate-limit-and-audit',
  proposalMd: `# Proposal: Add Distributed Rate Limiting & Immutable Audit Log

Внедрить адаптивный rate limiter (Token Bucket по API-ключу и IP) и структурированный журнал аудита безопасности для Order & Subscription API (~1500 LOC brownfield).
Цель: защитить биллинг и эндпоинты заказов от всплесков нагрузки (HTTP 429 + Retry-After) и обеспечить 100% трассировку мутирующих операций (create/cancel/refund).
Ограничения: обратная совместимость заголовков, задержка middleware <= 3 ms, нулевая потеря аудит-событий при сбое sink.`,

  specsMd: {
    'rate-limiting': `# Rate Limiting Specification

### [REQ-01] Token Bucket Per API Key & Tenant Tier
Given клиент с API-ключом тарифа \`pro\` (120 req/min, burst 30)
When поступает серия запросов в эндпоинты \`/api/v1/orders/*\`
Then лимитер списывает 1 токен из бакета ключа и пропускает запрос при остатке >= 0.

### [REQ-02] Fallback IP Sliding Window for Anonymous Routes
Given неаутентифицированный запрос без \`X-API-Key\`
When количество запросов с IP превышает 20 req/min
Then сервер отклоняет запрос до попадания в бизнес-обработчик.

### [REQ-03] Standard HTTP 429 & RateLimit Headers
Given исчерпан баланс токенов в бакете
When клиент выполняет следующий запрос
Then ответ содержит статус 429, заголовки \`X-RateLimit-Remaining: 0\`, \`X-RateLimit-Reset\` и \`Retry-After\`.

### [REQ-04] Whitelist Bypass for Health & Internal Metrics
Given запрос на \`/healthz\` или \`/metrics\` с внутреннего CIDR
When middleware проверяет маршрут
Then rate limiting не применяется и счётчик бакета не уменьшается.

### [REQ-05] Atomic Store Update Under Concurrency
Given 50 конкурентных async-запросов на один API-ключ
When бакет имеет 10 оставшихся токенов
Then ровно 10 запросов получают HTTP 200 и 40 получают HTTP 429 без race condition.`,

    'audit-log': `# Audit Log Specification

### [REQ-06] Immutable Audit Event Schema
Given любая мутирующая операция (\`POST\`, \`PUT\`, \`DELETE\`) над заказами или подписками
When запрос завершается (успешно или с 4xx/5xx)
Then формируется событие \`AuditEvent(event_id, actor_id, action, resource_id, status_code, ts_utc, request_hash)\`.

### [REQ-07] Sensitive Field Redaction Before Persist
Given тело запроса содержит \`card_number\`, \`cvv\` или \`api_secret\`
When формируется payload аудит-события
Then чувствительные поля маскируются как \`***REDACTED***\` до записи в хранилище.

### [REQ-08] Buffered Async Flush with Backpressure
Given поток из 500 аудит-событий в секунду
When размер буфера достигает 64 событий или проходит 500 ms
Then фоновый воркер сбрасывает батч асинхронно без блокировки HTTP-ответа.

### [REQ-09] Fallback Spool File on Primary Sink Failure
Given основное хранилище аудита (PostgreSQL/HTTP sink) временно недоступно
When воркер пытается записать батч
Then события сохраняются в локальный NDJSON spool-файл для последующей доставки.

### [REQ-10] Queryable Audit Trail Endpoint for Admins
Given администратор с ролью \`security_admin\`
When он запрашивает \`GET /api/v1/audit?actor_id=...&from=...\`
Then возвращается пагинированный список событий, отсортированный по \`ts_utc DESC\`.`,
  },

  designMd: `# Architecture & Design: Rate Limiting + Audit Log

## [DES-01] Token Bucket Store & Lua/Asyncio Lock Abstraction
Linked requirements: REQ-01, REQ-02, REQ-05
Интерфейс \`RateLimitStore\` с методами \`consume(key, capacity, refill_per_sec) -> QuotaResult\`.
Использует per-key \`asyncio.Lock\` в in-memory backend и атомарный скрипт в Redis-адаптере, гарантируя отсутствие race conditions при конкурентных запросах.

## [DES-02] FastAPI RateLimitMiddleware & Bypass Rules
Linked requirements: REQ-02, REQ-03, REQ-04
ASGI-middleware \`RateLimitMiddleware\`: извлекает \`X-API-Key\` или \`client.host\`, проверяет \`BYPASS_PATHS = {"/healthz", "/metrics"}\`, добавляет \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`, а при отказе возвращает JSON \`429\` с \`Retry-After\`.

## [DES-03] AuditEvent Pydantic Model & PII Redactor
Linked requirements: REQ-06, REQ-07
Модель \`AuditEvent\` (frozen=True) и функция \`redact_payload(data, sensitive_keys)\`, рекурсивно заменяющая секретные поля на \`***REDACTED***\` и вычисляющая SHA-256 \`request_hash\`.

## [DES-04] Async Ring Buffer & NDJSON Spool Fallback
Linked requirements: REQ-08, REQ-09
\`AuditDispatcher\` на базе \`asyncio.Queue(maxsize=2048)\`. Батчинг по 64 события или таймауту 0.5s. При исключении в \`primary_sink.write_batch()\` — запись в \`audit_spool.ndjson\` с ротацией.

## [DES-05] Admin Audit Query Router & RBAC Guard
Linked requirements: REQ-10
Роутер \`GET /api/v1/audit\` с проверкой \`require_role("security_admin")\`, фильтрами \`actor_id\`, \`action\`, \`from_ts\`, \`to_ts\` и cursor/offset пагинацией.

## [DES-06] Integration & Concurrency Test Harness
Linked requirements: REQ-01, REQ-03, REQ-05, REQ-07, REQ-09, REQ-10
Набор \`pytest-asyncio\` тестов с \`httpx.AsyncClient\`, проверяющих 50 параллельных запросов, редактирование секретов и fallback spool.`,

  tasksMd: `# Implementation Tasks (10 Tasks)

- [x] [TSK-01] Реализовать \`RateLimitStore\` и алгоритм Token Bucket в \`src/middleware/rate_limiter.py\` (REQ-01, REQ-05, DES-01)
- [x] [TSK-02] Добавить IP sliding-window fallback для анонимных клиентов в \`src/middleware/rate_limiter.py\` (REQ-02, DES-01, DES-02)
- [x] [TSK-03] Реализовать \`RateLimitMiddleware\` с HTTP 429 и заголовками \`Retry-After\` в \`src/middleware/rate_limiter.py\` (REQ-03, DES-02)
- [x] [TSK-04] Добавить whitelist-исключения \`/healthz\` и \`/metrics\` в \`src/middleware/rate_limiter.py\` (REQ-04, DES-02)
- [x] [TSK-05] Создать immutable модель \`AuditEvent\` и \`redact_payload\` в \`src/audit/audit_logger.py\` (REQ-06, REQ-07, DES-03)
- [x] [TSK-06] Реализовать \`AuditDispatcher\` с батчевым async-сбросом (64 / 500ms) в \`src/audit/audit_logger.py\` (REQ-08, DES-04)
- [x] [TSK-07] Реализовать NDJSON spool fallback при сбое основного sink в \`src/audit/audit_logger.py\` (REQ-09, DES-04)
- [x] [TSK-08] Подключить audit middleware к мутирующим маршрутам заказов в \`src/api/orders_router.py\` (REQ-06, REQ-08, DES-03)
- [x] [TSK-09] Реализовать эндпоинт \`GET /api/v1/audit\` с проверкой роли \`security_admin\` в \`src/api/audit_router.py\` (REQ-10, DES-05)
- [x] [TSK-10] Покрыть все требования \`REQ-01..REQ-10\` интеграционными и конкурентными тестами в \`tests/test_rate_limit_audit.py\` (REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, DES-06)`,
};

export const DEMO_KNOWN_CONTRACTS = [
  { taskId: 'TSK-01', file: 'src/middleware/rate_limiter.py', symbol: 'RateLimitStore.consume()', reqs: ['REQ-01', 'REQ-05'] },
  { taskId: 'TSK-02', file: 'src/middleware/rate_limiter.py', symbol: 'resolve_client_bucket_key()', reqs: ['REQ-02'] },
  { taskId: 'TSK-03', file: 'src/middleware/rate_limiter.py', symbol: 'RateLimitMiddleware.dispatch()', reqs: ['REQ-03'] },
  { taskId: 'TSK-04', file: 'src/middleware/rate_limiter.py', symbol: 'BYPASS_PATHS', reqs: ['REQ-04'] },
  { taskId: 'TSK-05', file: 'src/audit/audit_logger.py', symbol: 'AuditEvent, redact_payload()', reqs: ['REQ-06', 'REQ-07'] },
  { taskId: 'TSK-06', file: 'src/audit/audit_logger.py', symbol: 'AuditDispatcher.flush_loop()', reqs: ['REQ-08'] },
  { taskId: 'TSK-07', file: 'src/audit/audit_logger.py', symbol: 'AuditDispatcher.write_spool_ndjson()', reqs: ['REQ-09'] },
  { taskId: 'TSK-08', file: 'src/api/orders_router.py', symbol: 'audit_mutation_hook()', reqs: ['REQ-06', 'REQ-08'] },
  { taskId: 'TSK-09', file: 'src/api/audit_router.py', symbol: 'list_audit_events()', reqs: ['REQ-10'] },
];

export const DEMO_SAMPLE_PYTHON_FILE = `import asyncio
import time
from dataclasses import dataclass
from typing import Dict, Optional

BYPASS_PATHS = {"/healthz", "/metrics"}

@dataclass
class QuotaResult:
    """Result of token bucket consumption check."""
    allowed: bool
    remaining: int
    reset_after_sec: int

class RateLimitStore:
    """Thread/async-safe per-key Token Bucket store (@spec:REQ-01, @spec:REQ-05)."""
    def __init__(self) -> None:
        self._buckets: Dict[str, tuple[float, float]] = {}
        self._locks: Dict[str, asyncio.Lock] = {}

    def _get_lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    async def consume(self, key: str, capacity: int, refill_per_sec: float) -> QuotaResult:
        """Atomically deduct 1 token from key bucket."""
        async with self._get_lock(key):
            now = time.monotonic()
            tokens, last_ts = self._buckets.get(key, (float(capacity), now))
            elapsed = max(0.0, now - last_ts)
            tokens = min(float(capacity), tokens + elapsed * refill_per_sec)
            if tokens < 1.0:
                reset_sec = max(1, int((1.0 - tokens) / max(refill_per_sec, 0.01)))
                self._buckets[key] = (tokens, now)
                return QuotaResult(allowed=False, remaining=0, reset_after_sec=reset_sec)
            tokens -= 1.0
            self._buckets[key] = (tokens, now)
            return QuotaResult(allowed=True, remaining=int(tokens), reset_after_sec=1)`;

export const DEMO_GATE_FILES: GateSourceFile[] = [
  {
    path: 'src/middleware/rate_limiter.py',
    content: `# @spec:REQ-01 @spec:REQ-02 @spec:REQ-03 @spec:REQ-04 @spec:REQ-05
class RateLimitMiddleware:
    pass`,
  },
  {
    path: 'src/audit/audit_logger.py',
    content: `# @spec:REQ-06 @spec:REQ-07 @spec:REQ-08 @spec:REQ-09
class AuditDispatcher:
    pass`,
  },
  {
    path: 'src/api/audit_router.py',
    content: `# @spec:REQ-10
async def list_audit_events():
    return []`,
  },
  {
    path: 'tests/test_rate_limit_audit.py',
    isTest: true,
    content: `# @spec:REQ-01 @spec:REQ-02 @spec:REQ-03 @spec:REQ-04 @spec:REQ-05
# @spec:REQ-06 @spec:REQ-07 @spec:REQ-08 @spec:REQ-09 @spec:REQ-10
def test_all_reqs_covered():
    assert True`,
  },
];

export const DEMO_RAW_PYTEST_LOG = `============================= test session starts ==============================
platform linux -- Python 3.11.8, pytest-8.2.0, pluggy-1.5.0
rootdir: /workspace/orders-service
configfile: pyproject.toml
plugins: asyncio-0.23.6, cov-5.0.0
collecting ... 18 items

tests/test_orders_crud.py::test_create_order PASSED [  5%]
tests/test_orders_crud.py::test_get_order_by_id PASSED [ 11%]
tests/test_orders_crud.py::test_cancel_order_refund PASSED [ 16%]
tests/test_orders_crud.py::test_list_orders_paginated PASSED [ 22%]
tests/test_subscriptions.py::test_upgrade_plan PASSED [ 27%]
tests/test_subscriptions.py::test_pause_subscription PASSED [ 33%]
tests/test_rate_limit_audit.py::test_token_bucket_pro_tier PASSED [ 38%]
tests/test_rate_limit_audit.py::test_anonymous_ip_fallback PASSED [ 44%]
tests/test_rate_limit_audit.py::test_healthz_bypass PASSED [ 50%]
tests/test_rate_limit_audit.py::test_concurrent_50_requests PASSED [ 55%]
tests/test_rate_limit_audit.py::test_audit_redacts_card_fields PASSED [ 61%]
tests/test_rate_limit_audit.py::test_spool_fallback_on_sink_error FAILED [ 66%]
tests/test_rate_limit_audit.py::test_admin_audit_query PASSED [ 72%]

=================================== FAILURES ===================================
_______________________ test_spool_fallback_on_sink_error ______________________

    async def test_spool_fallback_on_sink_error(tmp_path):
        sink = FailingAuditSink()
        dispatcher = AuditDispatcher(sink=sink, spool_path=tmp_path / "audit_spool.ndjson")
        await dispatcher.enqueue(sample_event)
        await dispatcher.flush_once()
>       assert (tmp_path / "audit_spool.ndjson").exists()
E       AssertionError: assert False
E        +  where False = exists()

/usr/lib/python3.11/asyncio/runners.py:190: in run
    return runner.run(main)
site-packages/pytest_asyncio/plugin.py:412: in inner
    return loop.run_until_complete(task)
tests/test_rate_limit_audit.py:142: AssertionError
=========================== short test summary info ============================
FAILED tests/test_rate_limit_audit.py::test_spool_fallback_on_sink_error - AssertionError: assert False
========================= 1 failed, 12 passed in 1.42s =========================`;

export const DEMO_RAW_GIT_DIFF = `diff --git a/src/middleware/rate_limiter.py b/src/middleware/rate_limiter.py
index 82a9b10..e104c2a 100644
--- a/src/middleware/rate_limiter.py
+++ b/src/middleware/rate_limiter.py
@@ -1,6 +1,12 @@
 import asyncio
 import time
 from dataclasses import dataclass
+from typing import Dict
+
+BYPASS_PATHS = {"/healthz", "/metrics"}
diff --git a/src/audit/audit_logger.py b/src/audit/audit_logger.py
index 112f09a..99c310b 100644
--- a/src/audit/audit_logger.py
+++ b/src/audit/audit_logger.py
@@ -42,8 +42,14 @@ class AuditDispatcher:
     async def flush_once(self) -> None:
         batch = self._drain()
         try:
             await self.primary_sink.write_batch(batch)
         except Exception:
-            pass
+            await self.write_spool_ndjson(batch)
diff --git a/src/api/orders_router.py b/src/api/orders_router.py
index 552a99c..552a99c 100644
--- a/src/api/orders_router.py
+++ b/src/api/orders_router.py
@@ -10,4 +10,4 @@ async def create_order(payload: OrderCreate):
     return await service.create(payload)`;
