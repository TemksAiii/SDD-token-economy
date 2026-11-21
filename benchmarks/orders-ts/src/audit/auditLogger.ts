import crypto from 'node:crypto';
import fs from 'node:fs';
import { AuditEvent } from '../types';

const SENSITIVE_KEYS = new Set(['card_number', 'cvv', 'api_secret', 'password']);

// @spec:REQ-06 @spec:REQ-07
export function redactPayload(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '***REDACTED***';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactPayload(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface AuditSink {
  writeBatch(events: AuditEvent[]): Promise<void>;
}

// @spec:REQ-08 @spec:REQ-09
export class AuditDispatcher {
  private queue: AuditEvent[] = [];

  constructor(
    private readonly primarySink: AuditSink,
    private readonly spoolPath?: string,
    private readonly batchSize = 64
  ) {}

  record(
    actorId: string,
    action: string,
    resourceId: string,
    statusCode: number,
    rawPayload: Record<string, unknown>
  ): AuditEvent {
    const redacted = redactPayload(rawPayload);
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(redacted))
      .digest('hex')
      .slice(0, 16);

    const event: AuditEvent = {
      eventId: crypto.randomUUID(),
      actorId,
      action,
      resourceId,
      statusCode,
      tsUtc: new Date().toISOString(),
      requestHash,
      payload: redacted,
    };
    this.queue.push(event);
    return event;
  }

  async flushOnce(): Promise<{ flushed: number; spooled: number }> {
    if (this.queue.length === 0) return { flushed: 0, spooled: 0 };
    const batch = this.queue.splice(0, this.batchSize);
    try {
      await this.primarySink.writeBatch(batch);
      return { flushed: batch.length, spooled: 0 };
    } catch {
      if (this.spoolPath) {
        const lines = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFileSync(this.spoolPath, lines, 'utf8');
      }
      return { flushed: 0, spooled: batch.length };
    }
  }
}
