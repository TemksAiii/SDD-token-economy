# Rate Limiting Spec

### [REQ-01] Token Bucket Capacity Check
Given API ключ клиента
When вызывается `TokenBucketStore.consume`
Then списывается 1 токен при остатке >= 1.

### [REQ-05] Deterministic Exhaustion Behavior
Given исчерпанный бакет
When поступает следующий запрос
Then возвращается `allowed=False` и `remaining=0`.
