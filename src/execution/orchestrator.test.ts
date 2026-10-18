import { beforeEach, describe, expect, it } from 'vitest';
import { previewExtendedTp, previewResetTp, activateExtendedTp, resetExtendedTp } from '../domain/extendedTp';
import { buildExecutionPlan } from '../domain/plan';
import { createSignal } from '../domain/signal';
import type { AuditEvent, MasterSignal } from '../domain/types';
import { NOW, NOW_ISO, STRATEGY, account, goldSpec, group } from '../test/fixtures';
import { ExecutionOrchestrator, type ExecutionState } from './orchestrator';
import { SimulatedExecutionProvider } from './simulator';
import { UnavailableMt5Provider } from './unavailableProvider';

const groups = [
  group({ id: 'A', name: 'A', sortOrder: 0, entryOffset: 0, accountIds: ['acc-1'] }),
  group({ id: 'B', name: 'B', sortOrder: 1, entryOffset: 3, accountIds: ['acc-2'] }),
  group({ id: 'C', name: 'C', sortOrder: 2, entryOffset: 5, accountIds: ['acc-3'] }),
];
const accounts = ['acc-1', 'acc-2', 'acc-3'].map((id) => account({ id, displayName: id }));
const empty: ExecutionState = { orders: [], fills: [], positions: [] };

let sim: SimulatedExecutionProvider;
let audit: AuditEvent[];
let orch: ExecutionOrchestrator;
let seq = 0;

function setup(provider = new SimulatedExecutionProvider({ now: () => NOW_ISO })) {
  sim = provider;
  audit = [];
  orch = new ExecutionOrchestrator({ provider, newId: () => `id-${++seq}`, now: () => NOW_ISO, audit: (e) => audit.push(e), tickSizeFor: () => 0.01 });
}

function plan(signal: MasterSignal, state: ExecutionState, market = { bid: 4080.3, ask: 4080.5, sessionOpen: true }) {
  return buildExecutionPlan(signal, { accounts, groups, specs: [goldSpec()], profiles: [], orders: state.orders, positions: state.positions, context: 'simulation', emergencyDisabled: false, market, now: NOW });
}

const draft = { symbol: 'XAUUSD', direction: 'BUY' as const, referenceEntry: 4080, strategy: STRATEGY, groupIds: ['A', 'B', 'C'], marketForZeroOffset: false };

describe('simulated order lifecycle', () => {
  beforeEach(() => setup());

  it('submits staged limits, and a touch does not fill', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    expect(st.orders.map((o) => o.state)).toEqual(['acknowledged', 'acknowledged', 'acknowledged']);
    expect(st.orders.every((o) => o.simulated)).toBe(true);

    // Ask touches 4080.00 exactly → no fill.
    sim.setMarket('XAUUSD', { bid: 4079.8, ask: 4080, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    expect(st.fills).toHaveLength(0);

    // Trades through 4080 → group A fills; B (4077) and C (4075) remain pending.
    sim.setMarket('XAUUSD', { bid: 4079.7, ask: 4079.9, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    expect(st.orders.map((o) => o.state)).toEqual(['filled', 'acknowledged', 'acknowledged']);
    expect(st.positions).toHaveLength(1);
    // Filled at limit 4080 → SL 4065, TP 4083.
    expect(st.positions[0]).toMatchObject({ entryPrice: 4080, stopLoss: 4065, takeProfit: 4083 });
  });

  it('price can reach TP without later groups filling', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    sim.setMarket('XAUUSD', { bid: 4079.7, ask: 4079.9, sessionOpen: true });
    sim.setMarket('XAUUSD', { bid: 4083.1, ask: 4083.3, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    expect(st.positions[0]!.status).toBe('closed');
    expect(st.positions[0]!.closePrice).toBe(4083);
    expect(st.orders.slice(1).map((o) => o.state)).toEqual(['acknowledged', 'acknowledged']);
  });

  it('re-bases SL/TP on the actual fill price after a gap through the limit', async () => {
    sim.setFaults({ gapFillsAtMarket: true });
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    // Gap: ask jumps to 4076.40, through B's 4077 limit → B fills at 4076.40 (better price).
    sim.setMarket('XAUUSD', { bid: 4076.2, ask: 4076.4, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    const posB = st.positions.find((p) => p.groupId === 'B')!;
    expect(posB.entryPrice).toBe(4076.4);
    expect(posB.stopLoss).toBe(4061.4);
    expect(posB.takeProfit).toBe(4079.4);
    expect(posB.tpModification.state).toBe('confirmed');
    expect(audit.some((e) => e.action === 'modify_confirmed')).toBe(true);
  });

  it('handles partial fills and multiple fills with a VWAP entry', async () => {
    sim.setFaults({ partialFillRatio: 0.5, gapFillsAtMarket: true });
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', { ...draft, groupIds: ['B'] }, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    expect(st.orders[0]!.volume).toBe(0.33);
    sim.setMarket('XAUUSD', { bid: 4076.7, ask: 4076.9, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    expect(st.orders[0]!.state).toBe('partially_filled');
    expect(st.orders[0]!.filledVolume).toBe(0.16);
    sim.setMarket('XAUUSD', { bid: 4076.2, ask: 4076.4, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    expect(st.orders[0]!.state).toBe('filled');
    expect(st.fills.map((f) => [f.price, f.volume])).toEqual([[4076.9, 0.16], [4076.4, 0.17]]);
    const p = st.positions[0]!;
    expect(p.volume).toBe(0.33);
    // VWAP = (4076.9*0.16 + 4076.4*0.17)/0.33 = 4076.642…
    expect(p.entryPrice).toBe(4076.64);
    expect(p.stopLoss).toBe(4061.64);
    expect(p.takeProfit).toBe(4079.64);
  });

  it('records rejected orders with the provider reason', async () => {
    sim.setFaults({ rejectAccounts: ['acc-2'] });
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    const st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    const b = st.orders.find((o) => o.accountId === 'acc-2')!;
    expect(b.state).toBe('rejected');
    expect(b.rejectReason).toMatch(/fault injection/);
  });

  it('cancels pending orders and blocks duplicate re-submission', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    st = await orch.cancel(st.orders[1]!.clientOrderId, st, 'user');
    expect(st.orders[1]!.state).toBe('cancelled');

    // Retrying with the same (stale) plan does not create new orders.
    const before = st.orders.length;
    st = await orch.submit(sig, plan(sig, empty), st, { emergencyDisabled: false });
    expect(st.orders).toHaveLength(before);
    expect(audit.filter((e) => e.action === 'duplicate_prevented')).toHaveLength(3);
    // The simulator is idempotent too.
    expect((await sim.listOrders()).ok && (await sim.listOrders())).toMatchObject({ value: { length: 3 } });
  });

  it('emergency disable cancels all working orders and refuses new submissions', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    st = await orch.emergencyDisable(st);
    expect(st.orders.every((o) => o.state === 'cancelled')).toBe(true);
    const sig2 = createSignal('s2', draft, groups, 0.01, NOW_ISO);
    await expect(orch.submit(sig2, plan(sig2, empty), st, { emergencyDisabled: true })).rejects.toThrow(/Emergency/);
  });

  it('extended TP: positions and pending orders are modified only on confirmation; SL unchanged', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    let sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    sim.setMarket('XAUUSD', { bid: 4079.7, ask: 4079.9, sessionOpen: true });
    st = await orch.reconcile([sig], st);

    const preview = previewExtendedTp(sig, 4149, st.orders, st.positions, 0.01, 4079.7);
    expect(preview.validation.ok).toBe(true);
    sig = activateExtendedTp(sig, 4149, NOW_ISO);
    st = await orch.applyTpChanges(preview.changes, st);
    expect(st.positions[0]).toMatchObject({ takeProfit: 4149, stopLoss: 4065, tpModification: { state: 'confirmed' } });
    expect(st.orders.slice(1).map((o) => [o.takeProfit, o.stopLoss])).toEqual([[4149, 4062], [4149, 4060]]);

    // A later group fill inherits the active extended target.
    sim.setMarket('XAUUSD', { bid: 4076.7, ask: 4076.9, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    const posB = st.positions.find((p) => p.groupId === 'B')!;
    expect(posB).toMatchObject({ entryPrice: 4077, takeProfit: 4149, stopLoss: 4062 });

    // Reset → each position back to its own default TP.
    sig = resetExtendedTp(sig, NOW_ISO);
    st = await orch.applyTpChanges(previewResetTp(sig, st.orders, st.positions, 0.01), st);
    expect(st.positions.map((p) => p.takeProfit)).toEqual([4083, 4080]);
  });

  it('a failed TP modification keeps the old TP and records the reason', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', { ...draft, groupIds: ['A'] }, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    sim.setMarket('XAUUSD', { bid: 4079.7, ask: 4079.9, sessionOpen: true });
    st = await orch.reconcile([sig], st);
    sim.setFaults({ failModifyAccounts: ['acc-1'] });
    st = await orch.applyTpChanges(previewExtendedTp(sig, 4149, st.orders, st.positions, 0.01).changes, st);
    expect(st.positions[0]).toMatchObject({ takeProfit: 4083, stopLoss: 4065 });
    expect(st.positions[0]!.tpModification).toMatchObject({ state: 'failed', requested: 4149 });
    expect(st.positions[0]!.tpModification.reason).toMatch(/fault injection/);
    expect(audit.some((e) => e.action === 'modify_failed')).toBe(true);
  });

  it('a market entry fills at the market price and levels follow the actual fill', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', { ...draft, groupIds: ['A'], marketForZeroOffset: true }, groups, 0.01, NOW_ISO);
    const st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    expect(st.orders[0]!.state).toBe('filled');
    expect(st.positions[0]).toMatchObject({ entryPrice: 4080.5, stopLoss: 4065.5, takeProfit: 4083.5 });
  });

  it('marks orders unknown when the provider call throws, and never resubmits', async () => {
    sim.setMarket('XAUUSD', { bid: 4080.3, ask: 4080.5, sessionOpen: true });
    const sig = createSignal('s1', { ...draft, groupIds: ['B'] }, groups, 0.01, NOW_ISO);
    const original = sim.submitOrder.bind(sim);
    sim.submitOrder = () => Promise.reject(new Error('network down'));
    const st = await orch.submit(sig, plan(sig, empty), empty, { emergencyDisabled: false });
    expect(st.orders[0]!.state).toBe('unknown');
    sim.submitOrder = original;
    const again = await orch.submit(sig, plan(sig, empty), st, { emergencyDisabled: false });
    expect(again.orders).toHaveLength(1);
  });
});

describe('non-simulated providers', () => {
  it('the MT5 placeholder reports unsupported, never connected', async () => {
    const p = new UnavailableMt5Provider();
    expect(await p.connectionState()).toBe('unsupported');
    const r = await p.submitOrder();
    expect(r.ok).toBe(false);
  });
  it('the orchestrator refuses to submit to a non-simulated provider in this build', async () => {
    setup(new UnavailableMt5Provider() as unknown as SimulatedExecutionProvider);
    const sig = createSignal('s1', draft, groups, 0.01, NOW_ISO);
    await expect(orch.submit(sig, [], empty, { emergencyDisabled: false })).rejects.toThrow(/Live execution is disabled/);
    expect(audit[0]!.action).toBe('live_blocked');
  });
});
