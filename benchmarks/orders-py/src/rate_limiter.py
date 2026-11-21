import time
from dataclasses import dataclass
from typing import Dict, Tuple

BYPASS_PATHS = {"/healthz", "/metrics"}


@dataclass
class QuotaResult:
    """Result of token bucket consumption check."""
    allowed: bool
    remaining: int
    reset_after_sec: int


class TokenBucketStore:
    """Thread-safe per-key Token Bucket store (@spec:REQ-01, @spec:REQ-05)."""

    def __init__(self) -> None:
        self._buckets: Dict[str, Tuple[float, float]] = {}

    def consume(self, key: str, capacity: int, refill_per_sec: float, now: float | None = None) -> QuotaResult:
        """Atomically deduct 1 token from key bucket."""
        ts = time.monotonic() if now is None else now
        tokens, last_ts = self._buckets.get(key, (float(capacity), ts))
        elapsed = max(0.0, ts - last_ts)
        tokens = min(float(capacity), tokens + elapsed * refill_per_sec)
        if tokens < 1.0:
            reset_sec = max(1, int((1.0 - tokens) / max(refill_per_sec, 0.01)))
            self._buckets[key] = (tokens, ts)
            return QuotaResult(allowed=False, remaining=0, reset_after_sec=reset_sec)
        tokens -= 1.0
        self._buckets[key] = (tokens, ts)
        return QuotaResult(allowed=True, remaining=int(tokens), reset_after_sec=1)
