import { describe, expect, it } from 'vitest';
import { NOW, NOW_ISO, STRATEGY, account, goldSpec } from '../test/fixtures';
import { applyFill, averageFillPrice, canTransition, computeExposure, positionProfit, targetLevelsForFills, transitionOrder } from './orders';
import type { MasterSignal, Order, Position } from './types';

function order(o: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    clientOrderId: 's1:g1:acc-1',
    signalId: 's1',
    groupId: 'g1',
    accountId: 'acc-1',
    symbol: 'XAUUSD',
    direction: 'BUY',
    type: 'BUY_LIMIT',
    volume: 0.4,
    filledVolume: 0,
    limitPrice: 4077,
    stopLoss: 4062,
    takeProfit: 4080,
    state: 'acknowledged',
    providerName: 'sim',
    simulated: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...o,
  };
}

const signal: MasterSignal = {
  id: 's1',
  symbol: 'XAUUSD',
  direction: 'BUY',
  referenceEntry: 4080,
  strategy: STRATEGY,
  takeProfit: { kind: 'default_per_entry' },
  groupPlans: [],
  status: 'active',
  revision: 1,
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

describe('order state machine', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition('planned', 'pending_submission')).toBe(true);
    expect(canTransition('submitted', 'acknowledged')).toBe(true);
    expect(canTransition('acknowledged', 'partially_filled')).toBe(true);
    expect(canTransition('partially_filled', 'filled')).toBe(true);
    expect(canTransition('acknowledged', 'cancel_requested')).toBe(true);
    expect(canTransition('cancel_requested', 'cancelled')).toBe(true);
  });
  it('forbids leaving terminal states', () => {
    for (const s of ['filled', 'rejected', 'cancelled', 'expired'] as const) {
      expect(canTransition(s, 'acknowledged')).toBe(false);
    }
    expect(() => transitionOrder(order({ state: 'cancelled' }), 'acknowledged', NOW_ISO)).toThrow(/Invalid order transition/);
  });
  it('a cancel race can still end filled', () => {
    expect(canTransition('cancel_requested', 'filled')).toBe(true);
  });
});

describe('fills', () => {
  it('handles partial then full fills', () => {
    const p = applyFill(order(), { volume: 0.1, price: 4077 }, NOW_ISO);
    expect(p.state).toBe('partially_filled');
    expect(p.filledVolume).toBe(0.1);
    const f = applyFill(p, { volume: 0.3, price: 4076.9 }, NOW_ISO);
    expect(f.state).toBe('filled');
    expect(f.filledVolume).toBe(0.4);
  });
  it('rejects overfill and fills on cancelled orders', () => {
    expect(() => applyFill(order(), { volume: 0.5, price: 4077 }, NOW_ISO)).toThrow(/exceeds/);
    expect(() => applyFill(order({ state: 'cancelled' }), { volume: 0.1, price: 4077 }, NOW_ISO)).toThrow();
    expect(() => applyFill(order({ state: 'filled', filledVolume: 0.4 }), { volume: 0.1, price: 4077 }, NOW_ISO)).toThrow(/already/);
  });
  it('computes VWAP entry across multiple fills', () => {
    expect(averageFillPrice([{ price: 4077, volume: 0.1 }, { price: 4076, volume: 0.3 }], 0.01)).toBe(4076.25);
  });
  it('bases SL and default TP on the actual (VWAP) fill price, not the planned price', () => {
    const t = targetLevelsForFills(signal, [{ price: 4076.5, volume: 0.2 }, { price: 4076.1, volume: 0.2 }], 0.01);
    expect(t.entry).toBe(4076.3);
    expect(t.stopLoss).toBe(4061.3);
    expect(t.takeProfit).toBe(4079.3);
    expect(t.volume).toBe(0.4);
  });
  it('keeps extended absolute TP regardless of fill price', () => {
    const t = targetLevelsForFills({ ...signal, takeProfit: { kind: 'extended_absolute', price: 4149, activatedAt: NOW_ISO } }, [{ price: 4076.5, volume: 0.2 }], 0.01);
    expect(t.takeProfit).toBe(4149);
    expect(t.stopLoss).toBe(4061.5);
  });
});

describe('exposure', () => {
  it('sums open-position and working-order risk; ignores terminal orders and other accounts', () => {
    const pos: Position = {
      id: 'p1', orderId: 'o0', signalId: 's1', accountId: 'acc-1', groupId: 'g1', symbol: 'XAUUSD', direction: 'BUY',
      volume: 0.2, entryPrice: 4080, stopLoss: 4065, takeProfit: 4083, tpModification: { state: 'none' }, status: 'open', simulated: true, openedAt: NOW_ISO,
    };
    const orders = [
      order({ volume: 0.4, filledVolume: 0.1, state: 'partially_filled' }),
      order({ id: 'o2', clientOrderId: 'x', state: 'cancelled' }),
      order({ id: 'o3', clientOrderId: 'y', accountId: 'other' }),
    ];
    const e = computeExposure(account(), orders, [pos], () => goldSpec(), NOW);
    expect(e.openRisk).toBe(300);
    expect(e.pendingRisk).toBe(450);
    expect(e.errors).toEqual([]);
  });
  it('reports an error when exposure cannot be valued', () => {
    const e = computeExposure(account(), [order()], [], () => undefined, NOW);
    expect(e.errors).toHaveLength(1);
  });
});

describe('position profit', () => {
  const base = { direction: 'BUY' as const, entryPrice: 4080, volume: 0.2 };
  it('floating at the given price while open; realised at the close price once closed', () => {
    expect(positionProfit({ ...base, status: 'open' }, 4083, account(), goldSpec(), NOW)).toBe(60);
    expect(positionProfit({ ...base, status: 'closed', closePrice: 4065 }, 4100, account(), goldSpec(), NOW)).toBe(-300);
  });
  it('is undefined without a price, a spec, or a currency rate — never guessed', () => {
    expect(positionProfit({ ...base, status: 'open' }, undefined, account(), goldSpec(), NOW)).toBeUndefined();
    expect(positionProfit({ ...base, status: 'open' }, 4083, account(), undefined, NOW)).toBeUndefined();
    expect(positionProfit({ ...base, status: 'open' }, 4083, account({ currency: 'EUR' }), goldSpec(), NOW)).toBeUndefined();
  });
});
