import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const source = (relative: string) => pathToFileURL(path.resolve('src', relative)).href;
const guard = () => import(source('idempotency/idempotencyGuard.ts'));
const signer = () => import(source('webhooks/webhookSigner.ts'));

test('REQ-01 returns the stored value without invoking the replay handler', async () => {
  const { IdempotencyGuard } = await guard();
  const store = new IdempotencyGuard(100);
  let calls = 0;
  const handler = () => ({ orderId: ++calls });
  assert.deepEqual(await store.execute('key', 'hash', handler, 1000), { orderId: 1 });
  assert.deepEqual(await store.execute('key', 'hash', handler, 1050), { orderId: 1 });
  assert.equal(calls, 1);
});

test('REQ-02 rejects conflicting payloads before invoking their handlers', async () => {
  const { IdempotencyGuard, IdempotencyConflictError } = await guard();
  const store = new IdempotencyGuard(100);
  let calls = 0;
  const handler = () => ++calls;
  await store.execute('key', 'hash', handler, 1000);
  await assert.rejects(store.execute('key', 'different', handler, 1050), IdempotencyConflictError);
  assert.equal(calls, 1);
});

test('REQ-03 executes and stores a fresh response after TTL', async () => {
  const { IdempotencyGuard } = await guard();
  const store = new IdempotencyGuard(100);
  let calls = 0;
  const handler = () => ++calls;
  assert.equal(await store.execute('key', 'old', handler, 1000), 1);
  assert.equal(await store.execute('key', 'new', handler, 1101), 2);
  assert.equal(await store.execute('key', 'new', handler, 1102), 2);
  assert.equal(calls, 2);
});

const body = '{"id":1}';
const expected = 't=1000,v1=d3a89005f91de4309f7b063f6f889cd1e6dc7995c0c03fa87a0f4dc0a00330d9';

test('REQ-04 produces the exact HMAC-SHA256 header on a known vector', async () => {
  const { signWebhookPayload } = await signer();
  assert.equal(signWebhookPayload('secret', 1000, body), expected);
});

test('REQ-05 verifies matching input and rejects stale, tampered and malformed signatures', async () => {
  const { verifyWebhookSignature } = await signer();
  const verify = (header: string, payload = body, time = 1005, secret = 'secret') =>
    verifyWebhookSignature(secret, header, payload, time, 10);
  assert.equal(verify(expected), true);
  assert.equal(verify(expected, body, 1011), false);
  assert.equal(verify(expected, body, 989), false);
  assert.equal(verify(expected, body, 1005, 'wrong'), false);
  assert.equal(verify(expected, '{"id":2}'), false);
  assert.equal(verify(expected.replace('1000', '1000garbage')), false);
  assert.equal(verify(expected + 'junk'), false);
  assert.equal(verify(expected + '=junk'), false);
});

test('REQ-06 uses exponential backoff with the specified default cap', async () => {
  const { computeRetryDelayMs } = await signer();
  assert.deepEqual([1, 2, 3, 4, 5].map(attempt => computeRetryDelayMs(attempt)),
    [1000, 2000, 4000, 8000, 16000]);
  assert.equal(computeRetryDelayMs(8), 60000);
  assert.equal(computeRetryDelayMs(3, 250, 500), 500);
});

test('DES-02 keeps webhook operations in the canonical module', () => {
  const duplicates = fs.readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter(file => /\.[cm]?[jt]s$/.test(file) && file.split(path.sep).join('/') !== 'webhooks/webhookSigner.ts')
    .filter(file => /\b(?:function|(?:const|let|var))\s+(?:signWebhookPayload|verifyWebhookSignature|computeRetryDelayMs)\b/
      .test(fs.readFileSync(path.join('src', file), 'utf8')));
  assert.deepEqual(duplicates, []);
});
