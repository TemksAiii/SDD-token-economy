import unittest
from src.rate_limiter import TokenBucketStore


class TestRateLimiter(unittest.TestCase):
    # @spec:REQ-01 @spec:REQ-05
    def test_token_bucket_capacity_and_exhaustion(self) -> None:
        store = TokenBucketStore()
        self.assertTrue(store.consume("key:pro", 2, 1.0, now=10.0).allowed)
        self.assertTrue(store.consume("key:pro", 2, 1.0, now=10.0).allowed)
        blocked = store.consume("key:pro", 2, 1.0, now=10.0)
        self.assertFalse(blocked.allowed)
        self.assertEqual(blocked.remaining, 0)


if __name__ == "__main__":
    unittest.main()
