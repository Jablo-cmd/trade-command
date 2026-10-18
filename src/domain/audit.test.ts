import { describe, expect, it } from 'vitest';
import { createAuditEvent, sanitize } from './audit';

describe('audit sanitisation', () => {
  it('redacts credential-like keys at any depth', () => {
    const out = sanitize({ login: 123, password: 'x', nested: { apiKey: 'k', investor_password: 'y', ok: 1 }, list: [{ token: 't' }] });
    expect(out).toEqual({ login: 123, password: '[redacted]', nested: { apiKey: '[redacted]', investor_password: '[redacted]', ok: 1 }, list: [{ token: '[redacted]' }] });
  });
  it('creates events with sanitised details', () => {
    const e = createAuditEvent('id', 'at', 'account', 'update', 'msg', { details: { secret: 's', volume: 1 } });
    expect(e.details).toEqual({ secret: '[redacted]', volume: 1 });
  });
});
