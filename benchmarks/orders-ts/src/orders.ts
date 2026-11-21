import { InMemoryOrderStore } from './store';
import { OrderRecord } from './types';

export class OrderService {
  constructor(private readonly store: InMemoryOrderStore) {}

  createOrder(
    id: string,
    tenantId: string,
    amountCents: number,
    currency: 'RUB' | 'USD' = 'RUB'
  ): OrderRecord {
    if (amountCents <= 0) {
      throw new Error('Order amount must be positive');
    }
    return this.store.save({
      id,
      tenantId,
      amountCents,
      currency,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  cancelOrder(id: string): OrderRecord {
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Order ${id} not found`);
    }
    if (existing.status === 'refunded') {
      throw new Error(`Cannot cancel refunded order ${id}`);
    }
    return this.store.save({ ...existing, status: 'cancelled' });
  }
}
