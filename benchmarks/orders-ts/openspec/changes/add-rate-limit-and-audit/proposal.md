# Proposal: Add Distributed Rate Limiting & Immutable Audit Log

Внедрить адаптивный rate limiter (Token Bucket по API-ключу и IP) и структурированный журнал аудита безопасности для Order & Subscription API.
Цель: защитить биллинг и эндпоинты заказов от всплесков нагрузки (HTTP 429 + Retry-After) и обеспечить 100% трассировку мутирующих операций.
Ограничения: обратная совместимость заголовков, нулевая потеря аудит-событий при сбое sink.
