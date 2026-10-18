import { describe, expect, it } from 'vitest';
import { NOW_ISO, STRATEGY, group } from '../test/fixtures';
import { activateExtendedTp, previewExtendedTp, previewResetTp, resetExtendedTp } from './extendedTp';
import { createSignal, validateSignalDraft } from './signal';
import type { Order, Position } from './types';

const groups = [group({ id: 'A', entryOffset: 0 }), group({ id: 'B', name: 'B', sortOrder: 1, entryOffset: 3 })];
const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['A', 'B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);

const pos: Position = {
  id: 'p1', orderId: 'o1', signalId: 's1', accountId: 'acc-1', groupId: 'A', symbol: 'XAUUSD', direction: 'BUY',
  volume: 0.3, entryPrice: 4080, stopLoss: 4065, takeProfit: 4083, tpModification: { state: 'none' }, status: 'open', simulated: true, openedAt: NOW_ISO,
};
const pending = { id: 'o2', signalId: 's1', accountId: 'acc-2', limitPrice: 4077, stopLoss: 4062, takeProfit: 4080, state: 'acknowledged' } as Order;

describe('extended TP override', () => {
  it('activation sets a shared absolute target and bumps revision', () => {
    const s = activateExtendedTp(sig, 4149, NOW_ISO);
    expect(s.takeProfit).toEqual({ kind: 'extended_absolute', price: 4149, activatedAt: NOW_ISO });
    expect(s.revision).toBe(sig.revision + 1);
  });

  it('preview lists open positions and pending entries, SL unchanged', () => {
    const p = previewExtendedTp(sig, 4149, [pending], [pos], 0.01);
    expect(p.validation.ok).toBe(true);
    expect(p.changes).toEqual([
      { kind: 'position', id: 'p1', accountId: 'acc-1', entry: 4080, currentTp: 4083, newTp: 4149, stopLoss: 4065 },
      { kind: 'order', id: 'o2', accountId: 'acc-2', entry: 4077, currentTp: 4080, newTp: 4149, stopLoss: 4062 },
    ]);
  });

  it('rejects a directionally invalid target', () => {
    expect(previewExtendedTp(sig, 4079, [pending], [pos], 0.01).validation.ok).toBe(false);
  });

  it('reset returns each item to its own default TP from its entry', () => {
    const active = activateExtendedTp(sig, 4149, NOW_ISO);
    const changes = previewResetTp(active, [{ ...pending, takeProfit: 4149 }], [{ ...pos, takeProfit: 4149 }], 0.01);
    expect(changes.map((c) => c.newTp)).toEqual([4083, 4080]);
    expect(resetExtendedTp(active, NOW_ISO).takeProfit).toEqual({ kind: 'default_per_entry' });
  });

  it('cannot be activated on a closed setup', () => {
    expect(() => activateExtendedTp({ ...sig, status: 'closed' }, 4149, NOW_ISO)).toThrow();
  });
});

describe('signal draft validation', () => {
  it('rejects an extended TP on the wrong side and missing groups', () => {
    const v = validateSignalDraft({ symbol: 'XAUUSD', direction: 'SELL', referenceEntry: 4080, strategy: STRATEGY, extendedTp: 4100, groupIds: [], marketForZeroOffset: false }, groups, 0.01);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toMatch(/SELL extended TP must be below/);
    expect(v.errors.join()).toMatch(/at least one group/);
  });
  it('rejects off-tick reference price', () => {
    expect(validateSignalDraft({ symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080.005, strategy: STRATEGY, groupIds: ['A'], marketForZeroOffset: false }, groups, 0.01).ok).toBe(false);
  });
  it('creates extended mode when an extended TP is given', () => {
    const s = createSignal('s2', { symbol: 'xauusd', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, extendedTp: 4149, groupIds: ['A'], marketForZeroOffset: true }, groups, 0.01, NOW_ISO);
    expect(s.symbol).toBe('XAUUSD');
    expect(s.takeProfit.kind).toBe('extended_absolute');
    expect(s.groupPlans[0]!.orderKind).toBe('market');
  });
});
