import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryOrderStore } from '../src/store';
import { OrderService } from '../src/orders';

test('OrderService creates and cancels orders', () => {
  const store = new InMemoryOrderStore();
  const service = new OrderService(store);
  const created = service.createOrder('ord-1', 'tenant-a', 4900, 'RUB');
  assert.equal(created.status, 'pending');
  const cancelled = service.cancelOrder('ord-1');
  assert.equal(cancelled.status, 'cancelled');
});
