import { describe, expect, it } from 'vitest';
import { NOW, NOW_ISO, STRATEGY, account, goldSpec, group, verifiedProfile } from '../test/fixtures';
import { buildExecutionPlan, clientOrderIdFor, planSummary, type PlanContext } from './plan';
import { createSignal } from './signal';
import type { Order } from './types';

const groups = [
  group({ id: 'A', name: 'A', sortOrder: 0, entryOffset: 0, accountIds: ['acc-1'] }),
  group({ id: 'B', name: 'B', sortOrder: 1, entryOffset: 3, accountIds: ['acc-2'] }),
];
const accounts = [account({ id: 'acc-1' }), account({ id: 'acc-2', displayName: 'Test Account 2' })];
const market = { bid: 4080.3, ask: 4080.5, sessionOpen: true };

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return { accounts, groups, specs: [goldSpec()], profiles: [], orders: [], positions: [], context: 'simulation', emergencyDisabled: false, market, now: NOW, ...over };
}

const draft = { symbol: 'XAUUSD', direction: 'BUY' as const, referenceEntry: 4080, strategy: STRATEGY, groupIds: ['A', 'B'], marketForZeroOffset: false };

describe('execution plan', () => {
  it('creates one planned order per account with staged levels, SL and TP', () => {
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx());
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => [p.entryPrice, p.stopLoss, p.takeProfit])).toEqual([
      [4080, 4065, 4083],
      [4077, 4062, 4080],
    ]);
    expect(plan.every((p) => p.status === 'ready')).toBe(true);
    expect(plan[0]!.risk?.volume).toBe(0.33);
  });

  it('evaluates each account individually', () => {
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ accounts: [accounts[0]!, account({ id: 'acc-2', tradingEnabled: false })] }));
    expect(plan[0]!.status).toBe('ready');
    expect(plan[1]!.status).toBe('blocked');
    expect(plan[1]!.blockers.join()).toMatch(/Trading is disabled/);
  });

  it('accumulates exposure when one account participates in several groups', () => {
    const g = [groups[0]!, { ...groups[1]!, accountIds: ['acc-1'] }];
    const acc = account({ id: 'acc-1', riskSettings: { maxRiskPerTrade: 500, maxAggregateRisk: 600, maxSnapshotAgeMinutes: 60 } });
    const sig = createSignal('s1', draft, g, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ accounts: [acc], groups: g }));
    expect(plan[0]!.risk?.volume).toBe(0.33);
    // Second order only has 600 - 495 = 105 budget left → 0.07 lots.
    expect(plan[1]!.risk?.budget).toBeCloseTo(105);
    expect(plan[1]!.risk?.volume).toBe(0.07);
  });

  it('applies a group-level risk cap across its accounts', () => {
    const g = [{ ...groups[0]!, accountIds: ['acc-1', 'acc-2'], maxGroupRisk: 700 }];
    const sig = createSignal('s1', { ...draft, groupIds: ['A'] }, g, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ groups: g }));
    expect(plan[0]!.risk?.riskAmount).toBe(495);
    expect(plan[1]!.risk?.budget).toBeCloseTo(205);
  });

  it('blocks invalid limit orders (BUY limit at or above ask)', () => {
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ market: { bid: 4079.8, ask: 4080, sessionOpen: true } }));
    expect(plan[0]!.status).toBe('blocked');
    expect(plan[0]!.blockers.join()).toMatch(/must be below current ask/);
    expect(plan[1]!.status).toBe('ready');
  });

  it('uses market price for a zero-offset market entry', () => {
    const sig = createSignal('s1', { ...draft, marketForZeroOffset: true }, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx());
    expect(plan[0]!.orderType).toBe('BUY_MARKET');
    expect(plan[0]!.entryPrice).toBe(4080.5);
    expect(plan[0]!.stopLoss).toBe(4065.5);
    expect(plan[1]!.orderType).toBe('BUY_LIMIT');
  });

  it('prevents duplicate orders for the same signal/group/account', () => {
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const existing = { clientOrderId: clientOrderIdFor('s1', 'A', 'acc-1'), state: 'acknowledged' } as Order;
    const plan = buildExecutionPlan(sig, ctx({ orders: [existing] }));
    expect(plan[0]!.status).toBe('already_submitted');
    expect(planSummary(plan).alreadySubmitted).toBe(1);
  });

  it('holds groups that need approval', () => {
    const g = [groups[0]!, { ...groups[1]!, requireApproval: true }];
    const sig = createSignal('s1', draft, g, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ groups: g }));
    expect(plan[1]!.status).toBe('awaiting_approval');
  });

  it('live context blocks everything without a real verified connection', () => {
    const acc = accounts.map((a) => ({ ...a, executionMode: 'live_automated' as const, compatibilityProfileId: 'cp-1' }));
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ accounts: acc, profiles: [verifiedProfile()], context: 'live' }));
    expect(plan.every((p) => p.status === 'blocked')).toBe(true);
  });

  it('live context blocks an unverified instrument spec even with otherwise valid setup', () => {
    const acc = accounts.map((a) => ({
      ...a,
      executionMode: 'live_automated' as const,
      compatibilityProfileId: 'cp-1',
      connectionStatus: 'connected' as const,
      snapshot: { balance: 1e5, equity: 1e5, dailyLossUsed: 0, drawdownReference: 1e5, source: 'provider' as const, asOf: NOW_ISO },
    }));
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const ok = buildExecutionPlan(sig, ctx({ accounts: acc, profiles: [verifiedProfile()], context: 'live' }));
    expect(ok.every((p) => p.status === 'ready')).toBe(true);
    const bad = buildExecutionPlan(sig, ctx({ accounts: acc, profiles: [verifiedProfile()], context: 'live', specs: [goldSpec({ verification: { status: 'user_supplied' } })] }));
    expect(bad.every((p) => p.status === 'blocked')).toBe(true);
  });

  it('blocks when the spec is missing for an account server', () => {
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const plan = buildExecutionPlan(sig, ctx({ specs: [] }));
    expect(plan.every((p) => p.status === 'blocked')).toBe(true);
    expect(plan[0]!.blockers.join()).toMatch(/No XAUUSD instrument specification/);
  });
});
