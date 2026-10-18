/**
 * Audit event construction with credential redaction.
 */
import type { AuditCategory, AuditEvent } from './types';

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[_-]?key|credential|investor|private[_-]?key|service[_-]?role/i;

/** Recursively redact values under sensitive-looking keys. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1)]),
    );
  }
  return value;
}

export function createAuditEvent(
  id: string,
  at: string,
  category: AuditCategory,
  action: string,
  message: string,
  opts: { entityId?: string; details?: Record<string, unknown>; simulated?: boolean } = {},
): AuditEvent {
  return {
    id,
    at,
    category,
    action,
    message,
    entityId: opts.entityId,
    details: opts.details ? (sanitize(opts.details) as Record<string, unknown>) : undefined,
    simulated: opts.simulated,
  };
}
