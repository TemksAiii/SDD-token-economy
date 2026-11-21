import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenBucketRateLimiter } from '../src/middleware/rateLimiter';
import { AuditDispatcher, redactPayload } from '../src/audit/auditLogger';
import { queryAuditTrail } from '../src/routes/auditRouter';

// @spec:REQ-01 @spec:REQ-02 @spec:REQ-03 @spec:REQ-04 @spec:REQ-05
test('TokenBucketRateLimiter enforces key/IP quotas, headers, bypass, and concurrency', () => {
  const limiter = new TokenBucketRateLimiter(3, 1, 2);
  const now = 100000;

  assert.equal(limiter.consume('/healthz', undefined, '10.0.0.1', now).status, 200);
  assert.equal(limiter.consume('/api/v1/orders', 'k-pro', undefined, now).status, 200);
  assert.equal(limiter.consume('/api/v1/orders', 'k-pro', undefined, now).status, 200);
  assert.equal(limiter.consume('/api/v1/orders', 'k-pro', undefined, now).status, 200);

  const blocked = limiter.consume('/api/v1/orders', 'k-pro', undefined, now);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['X-RateLimit-Remaining'], '0');
  assert.ok(Number(blocked.headers['Retry-After']) >= 1);

  const anon1 = limiter.consume('/api/v1/orders', undefined, '192.168.1.10', now);
  const anon2 = limiter.consume('/api/v1/orders', undefined, '192.168.1.10', now);
  const anon3 = limiter.consume('/api/v1/orders', undefined, '192.168.1.10', now);
  assert.equal(anon1.status, 200);
  assert.equal(anon2.status, 200);
  assert.equal(anon3.status, 429);
});

// @spec:REQ-06 @spec:REQ-07 @spec:REQ-08 @spec:REQ-09 @spec:REQ-10
test('AuditDispatcher redacts secrets, spools on primary sink failure, and supports admin query', async () => {
  const redacted = redactPayload({ card_number: '4111', cvv: '999', order_id: 'ord-1' });
  assert.equal(redacted.card_number, '***REDACTED***');
  assert.equal(redacted.cvv, '***REDACTED***');
  assert.equal(redacted.order_id, 'ord-1');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spectrim-audit-'));
  const spoolFile = path.join(tmpDir, 'spool.ndjson');
  const failingSink = {
    writeBatch: async () => {
      throw new Error('sink unavailable');
    },
  };

  const dispatcher = new AuditDispatcher(failingSink, spoolFile);
  const ev = dispatcher.record('user-42', 'order.create', 'ord-1', 201, {
    card_number: '4111',
    amount: 1000,
  });
  const res = await dispatcher.flushOnce();
  assert.equal(res.spooled, 1);
  assert.ok(fs.existsSync(spoolFile));

  const results = queryAuditTrail([ev], { actorRole: 'security_admin', actorId: 'user-42' });
  assert.equal(results.length, 1);
  assert.throws(() => queryAuditTrail([ev], { actorRole: 'viewer' }), /Forbidden/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
