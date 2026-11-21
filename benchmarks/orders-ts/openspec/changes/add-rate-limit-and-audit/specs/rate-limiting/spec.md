# Rate Limiting Specification

### [REQ-01] Token Bucket Per API Key & Tenant Tier
Given клиент с API-ключом тарифа `pro`
When поступает серия запросов в `/api/v1/orders/*`
Then лимитер списывает 1 токен из бакета ключа и пропускает запрос при остатке >= 0.

### [REQ-02] Fallback IP Sliding Window for Anonymous Routes
Given неаутентифицированный запрос без `X-API-Key`
When количество запросов с IP превышает лимит
Then сервер отклоняет запрос со статусом 429.

### [REQ-03] Standard HTTP 429 & RateLimit Headers
Given исчерпан баланс токенов в бакете
When клиент выполняет следующий запрос
Then ответ содержит статус 429, заголовки `X-RateLimit-Remaining: 0`, `X-RateLimit-Reset` и `Retry-After`.

### [REQ-04] Whitelist Bypass for Health & Internal Metrics
Given запрос на `/healthz` или `/metrics`
When лимитер проверяет маршрут
Then rate limiting не применяется и счётчик бакета не уменьшается.

### [REQ-05] Deterministic Quota Consumption Under Burst
Given серия конкурентных запросов на один API-ключ
When бакет имеет `capacity` токенов
Then ровно `capacity` запросов получают 200, остальные 429.
