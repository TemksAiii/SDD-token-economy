package com.acme.billing;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

// @spec:REQ-01 @spec:REQ-05
public class RateLimiter {
  private final Map<String, Double> buckets = new ConcurrentHashMap<>();
  private final int capacity;

  public RateLimiter(int capacity) {
    this.capacity = capacity;
  }

  public synchronized boolean tryAcquire(String apiKey) {
    double available = buckets.getOrDefault(apiKey, (double) capacity);
    if (available < 1.0) {
      return false;
    }
    buckets.put(apiKey, available - 1.0);
    return true;
  }
}
