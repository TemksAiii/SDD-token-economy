export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'refunded';

export type TenantTier = 'free' | 'pro' | 'enterprise';

export interface OrderRecord {
  id: string;
  tenantId: string;
  amountCents: number;
  currency: 'RUB' | 'USD';
  status: OrderStatus;
  createdAt: string;
}

export interface AuditEvent {
  eventId: string;
  actorId: string;
  action: string;
  resourceId: string;
  statusCode: number;
  tsUtc: string;
  requestHash: string;
  payload: Record<string, unknown>;
}

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  resetAfterSec: number;
}
