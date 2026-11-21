# Audit Log Specification

### [REQ-06] Immutable Audit Event Schema
Given любая мутирующая операция над заказами
When запрос завершается
Then формируется событие `AuditEvent(eventId, actorId, action, resourceId, statusCode, tsUtc, requestHash)`.

### [REQ-07] Sensitive Field Redaction Before Persist
Given payload содержит `card_number`, `cvv`, `api_secret` или `password`
When формируется аудит-событие
Then чувствительные поля маскируются как `***REDACTED***`.

### [REQ-08] Buffered Batch Flush
Given накопленные события в очереди `AuditDispatcher`
When вызывается `flushOnce()`
Then батч отправляется в `primarySink.writeBatch()`.

### [REQ-09] Fallback Spool File on Primary Sink Failure
Given основное хранилище аудита недоступно
When воркер пытается записать батч
Then события сохраняются в локальный NDJSON spool-файл.

### [REQ-10] Queryable Audit Trail Endpoint for Admins
Given администратор с ролью `security_admin`
When он запрашивает аудит-лог
Then возвращается отсортированный по `tsUtc DESC` список, а прочим ролям возвращается ошибка доступа.
