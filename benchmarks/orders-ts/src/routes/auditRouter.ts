import { AuditEvent } from '../types';

export interface AuditQueryParams {
  actorRole: string;
  actorId?: string;
  limit?: number;
}

// @spec:REQ-10
export function queryAuditTrail(
  events: AuditEvent[],
  params: AuditQueryParams
): AuditEvent[] {
  if (params.actorRole !== 'security_admin') {
    throw new Error('Forbidden: security_admin role required');
  }
  const filtered = params.actorId
    ? events.filter((e) => e.actorId === params.actorId)
    : events;
  const sorted = [...filtered].sort((a, b) => b.tsUtc.localeCompare(a.tsUtc));
  return sorted.slice(0, params.limit ?? 50);
}
