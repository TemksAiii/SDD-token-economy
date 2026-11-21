package ratelimit

import (
	"sync"
	"time"
)

type QuotaResult struct {
	Allowed   bool
	Remaining int
	ResetSec  int
}

type bucketState struct {
	tokens float64
	last   time.Time
}

// @spec:REQ-01 @spec:REQ-05
type BucketStore struct {
	mu      sync.Mutex
	buckets map[string]*bucketState
}

func NewBucketStore() *BucketStore {
	return &BucketStore{buckets: make(map[string]*bucketState)}
}

func (s *BucketStore) Consume(key string, capacity int, refillPerSec float64) QuotaResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	st, ok := s.buckets[key]
	if !ok {
		st = &bucketState{tokens: float64(capacity), last: now}
		s.buckets[key] = st
	}
	elapsed := now.Sub(st.last).Seconds()
	st.tokens = min(float64(capacity), st.tokens+elapsed*refillPerSec)
	st.last = now
	if st.tokens < 1.0 {
		return QuotaResult{Allowed: false, Remaining: 0, ResetSec: 1}
	}
	st.tokens -= 1.0
	return QuotaResult{Allowed: true, Remaining: int(st.tokens), ResetSec: 1}
}
