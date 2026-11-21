import { OrderRecord } from './types';

export class InMemoryOrderStore {
  private readonly orders = new Map<string, OrderRecord>();

  save(order: OrderRecord): OrderRecord {
    this.orders.set(order.id, { ...order });
    return { ...order };
  }

  get(id: string): OrderRecord | undefined {
    const found = this.orders.get(id);
    return found ? { ...found } : undefined;
  }

  listByTenant(tenantId: string): OrderRecord[] {
    return Array.from(this.orders.values())
      .filter((o) => o.tenantId === tenantId)
      .map((o) => ({ ...o }));
  }
}
