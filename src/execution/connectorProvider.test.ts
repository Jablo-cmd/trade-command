import { describe, expect, it } from 'vitest';
import { buildExecutionPlan } from '../domain/plan';
import { createSignal } from '../domain/signal';
import type { AuditEvent } from '../domain/types';
import { NOW, NOW_ISO, STRATEGY, account, goldSpec, group, verifiedProfile } from '../test/fixtures';
import { ConnectorProvider, type ConnectorDb } from './connectorProvider';
import { ExecutionOrchestrator } from './orchestrator';

type Row = Record<string, unknown>;
const T = NOW.getTime();

/** Fake Supabase + a scripted connector that answers queued commands. */
class FakeConnector implements ConnectorDb {
  commands: Row[] = [];
  orders: Row[] = [];
  fills: Row[] = [];
  positions: Row[] = [];
  heartbeats: Row[] = [{
    account_id: 'acc-1', terminal_connected: true, login_verified: true, trade_mode: 'demo', balance: 100000, equity: 99800,
    daily_loss_used: 200, currency: 'USD', last_seen: NOW_ISO, quotes: { XAUUSD: { bid: 4080.3, ask: 4080.5, time: NOW_ISO } }, error: null,
  }];
  emergency = false;
  /** How the connector answers: 'accept' | 'reject' | 'silent' (never answers). */
  mode: 'accept' | 'reject' | 'silent' = 'accept';
  private seq = 0;

  async insertCommand(row: Row) {
    if (row.kind === 'submit' && this.commands.some((c) => c.kind === 'submit' && c.client_order_id === row.client_order_id)) {
      return { data: null, error: { code: '23505', message: 'duplicate key' } };
    }
    const cmd = { id: `cmd-${++this.seq}`, status: 'pending', ...row };
    this.commands.push(cmd);
    return { data: cmd, error: null };
  }
  async findSubmit(cid: string) {
    return { data: this.commands.find((c) => c.kind === 'submit' && c.client_order_id === cid) ?? null, error: null };
  }
  async getCommand(id: string) {
    const c = this.commands.find((x) => x.id === id)!;
    if (c.status === 'pending' && this.mode !== 'silent') this.process(c);
    return { data: c, error: null };
  }
  async list(table: string) {
    const t = { orders: this.orders, fills: this.fills, positions: this.positions, connector_heartbeats: this.heartbeats }[table]!;
    return { data: t, error: null };
  }
  async setEmergency(on: boolean) {
    this.emergency = on;
    return { data: null, error: null };
  }

  private process(c: Row) {
    // Like the real connector: the kill switch blocks new orders, not cancels or the stop itself.
    if (this.mode === 'reject' || (this.emergency && c.kind === 'submit')) {
      Object.assign(c, { status: 'rejected', result: { reasons: [this.emergency ? 'Emergency disable is active.' : 'Requested 0.33 lots exceeds the 0.2 lots allowed by current risk limits.'] } });
      return;
    }
    const p = c.payload as Row;
    if (c.kind === 'submit') {
      const id = `ord-${this.orders.length + 1}`;
      this.orders.push({
        id, client_order_id: c.client_order_id, account_id: c.account_id, signal_id: c.signal_id, group_id: p.group_id, symbol: p.symbol,
        direction: p.direction, order_type: `${p.direction}_${p.order_kind === 'limit' ? 'LIMIT' : 'MARKET'}`, volume: p.volume, filled_volume: 0,
        limit_price: p.entry, stop_loss: p.stop_loss, take_profit: p.take_profit, state: 'acknowledged', provider_order_id: String(5000 + this.orders.length),
      });
      Object.assign(c, { status: 'done', result: { order_id: id } });
    } else if (c.kind === 'cancel') {
      const o = this.orders.find((x) => x.client_order_id === c.client_order_id)!;
      o.state = 'cancelled';
      Object.assign(c, { status: 'done', result: { state: 'cancelled' } });
    } else if (c.kind === 'modify_tp') {
      const o = this.orders.find((x) => x.client_order_id === c.client_order_id)!;
      o.take_profit = p.take_profit;
      Object.assign(c, { status: 'done', result: { take_profit: p.take_profit, stop_loss: o.stop_loss } });
    } else if (c.kind === 'emergency_disable') {
      const n = this.orders.filter((o) => o.state === 'acknowledged').length;
      this.orders.forEach((o) => o.state === 'acknowledged' && (o.state = 'cancelled'));
      Object.assign(c, { status: 'done', result: { cancelled: n } });
    }
  }

  /** Simulate the connector reconciling a fill at an actual price (with its own SL/TP re-base). */
  fill(clientOrderId: string, price: number) {
    const o = this.orders.find((x) => x.client_order_id === clientOrderId)!;
    o.state = 'filled';
    o.filled_volume = o.volume;
    this.fills.push({ order_id: o.id, provider_fill_id: `deal-${this.fills.length + 1}`, price, volume: o.volume, filled_at: NOW_ISO });
    this.positions.push({ order_id: o.id, account_id: o.account_id, symbol: o.symbol, volume: o.volume, entry_price: price, stop_loss: price - 15,
      take_profit: price + 3, status: 'open', tp_modification_state: 'confirmed', tp_modification_requested: price + 3 });
  }
}

function setup(opts = {}) {
  const db = new FakeConnector();
  const provider = new ConnectorProvider(db, { now: () => T, sleep: async () => undefined, timeoutMs: 3, pollMs: 1, ...opts });
  const audit: AuditEvent[] = [];
  let i = 0;
  const orch = new ExecutionOrchestrator({ provider, newId: () => `id-${++i}`, now: () => NOW_ISO, audit: (e) => audit.push(e), tickSizeFor: () => 0.01 });
  return { db, provider, orch, audit };
}

const live = account({
  id: 'acc-1', executionMode: 'live_automated', compatibilityProfileId: 'cp-1', connectionStatus: 'connected',
  snapshot: { balance: 1e5, equity: 1e5, dailyLossUsed: 0, drawdownReference: 1e5, source: 'provider', asOf: NOW_ISO },
});
const groups = [group({ id: 'A', accountIds: ['acc-1'] }), group({ id: 'B', name: 'B', sortOrder: 1, entryOffset: 3, accountIds: ['acc-1'] })];
const empty = { orders: [], fills: [], positions: [] };

function plan(signal: ReturnType<typeof createSignal>, market = { bid: 4080.3, ask: 4080.5, sessionOpen: true }) {
  return buildExecutionPlan(signal, { accounts: [live], groups, specs: [goldSpec()], profiles: [verifiedProfile()], orders: [], positions: [],
    context: 'live', emergencyDisabled: false, market, now: NOW });
}

describe('ConnectorProvider', () => {
  it('reports live, server-validated, protection-managing provider', () => {
    const { provider } = setup();
    expect(provider.info).toMatchObject({ simulated: false, serverValidated: true, managesProtection: true });
  });

  it('derives connection and quotes from fresh heartbeats only', async () => {
    const { db, provider } = setup();
    expect(await provider.connectionState('acc-1')).toBe('connected');
    expect(await provider.getMarket('XAUUSD')).toEqual({ ok: true, value: { bid: 4080.3, ask: 4080.5, sessionOpen: true } });
    expect((await provider.accountStates())['acc-1']).toMatchObject({ tradeMode: 'demo', equity: 99800, dailyLossUsed: 200 });
    db.heartbeats[0]!.last_seen = new Date(T - 120_000).toISOString();
    expect(await provider.connectionState('acc-1')).toBe('disconnected');
    expect((await provider.getMarket('XAUUSD')).ok).toBe(false);
    db.heartbeats[0]!.last_seen = NOW_ISO;
    db.heartbeats[0]!.login_verified = false;
    expect(await provider.connectionState('acc-1')).toBe('unauthorized');
    expect(await provider.connectionState('unknown-acc')).toBe('disconnected');
  });

  it('orchestrator submits through the connector and adopts its result', async () => {
    const { db, orch } = setup();
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    const st = await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    expect(db.commands[0]).toMatchObject({ kind: 'submit', account_id: 'acc-1', signal_id: 's1', client_order_id: 's1:B:acc-1' });
    expect(db.commands[0]!.payload).toMatchObject({ order_kind: 'limit', entry: 4077, stop_loss: 4062, take_profit: 4080, volume: 0.33, direction: 'BUY' });
    expect(st.orders[0]).toMatchObject({ state: 'acknowledged', simulated: false, providerOrderId: '5000' });
  });

  it('connector rejection is shown with its reasons', async () => {
    const { db, orch } = setup();
    db.mode = 'reject';
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    const st = await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    expect(st.orders[0]!.state).toBe('rejected');
    expect(st.orders[0]!.rejectReason).toMatch(/exceeds the 0.2 lots allowed/);
  });

  it('no answer in time marks the order unknown (never assumed placed or failed)', async () => {
    const { db, orch } = setup();
    db.mode = 'silent';
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    const st = await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    expect(st.orders[0]!.state).toBe('unknown');
  });

  it('re-queuing the same order is idempotent', async () => {
    const { db, provider } = setup();
    const req = { clientOrderId: 's1:B:acc-1', signalId: 's1', groupId: 'B', accountId: 'acc-1', symbol: 'XAUUSD', type: 'BUY_LIMIT' as const, volume: 0.33, price: 4077, stopLoss: 4062, takeProfit: 4080 };
    await provider.submitOrder(req);
    const again = await provider.submitOrder(req);
    expect(again.ok).toBe(true);
    expect(db.commands.filter((c) => c.kind === 'submit')).toHaveLength(1);
    expect(db.orders).toHaveLength(1);
  });

  it('fills come from the connector; the client does not re-base SL/TP itself', async () => {
    const { db, orch } = setup();
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    db.fill('s1:B:acc-1', 4076.4);
    st = await orch.reconcile([sig], st);
    expect(st.orders[0]!.state).toBe('filled');
    expect(st.fills).toHaveLength(1);
    expect(st.positions[0]).toMatchObject({ entryPrice: 4076.4, stopLoss: 4061.4, takeProfit: 4079.4, tpModification: { state: 'confirmed' } });
    expect(db.commands.filter((c) => c.kind === 'modify_tp')).toHaveLength(0);
  });

  it('adopts orders placed from another device', async () => {
    const { orch } = setup();
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    const fresh = await orch.reconcile([sig], empty);
    expect(fresh.orders).toHaveLength(1);
    expect(fresh.orders[0]).toMatchObject({ clientOrderId: 's1:B:acc-1', signalId: 's1', groupId: 'B', state: 'acknowledged' });
  });

  it('cancel and TP change are confirmed by the connector', async () => {
    const { db, orch } = setup();
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig), empty, { emergencyDisabled: false });
    st = await orch.applyTpChanges([{ kind: 'order', id: st.orders[0]!.id, accountId: 'acc-1', entry: 4077, currentTp: 4080, newTp: 4149, stopLoss: 4062 }], st);
    expect(st.orders[0]).toMatchObject({ takeProfit: 4149, stopLoss: 4062 });
    st = await orch.cancel('s1:B:acc-1', st, 'user');
    expect(st.orders[0]!.state).toBe('cancelled');
    expect(db.commands.map((c) => c.kind)).toEqual(['submit', 'modify_tp', 'cancel']);
  });

  it('emergency disable sets the server switch and stops every account', async () => {
    const { db, orch, provider, audit } = setup();
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, groupIds: ['A', 'B'], marketForZeroOffset: false }, groups, 0.01, NOW_ISO);
    let st = await orch.submit(sig, plan(sig, { bid: 4081, ask: 4081.2, sessionOpen: true }), empty, { emergencyDisabled: false });
    st = await orch.emergencyDisable(st, ['acc-1'], [sig]);
    expect(db.emergency).toBe(true);
    expect(st.orders.every((o) => o.state === 'cancelled')).toBe(true);
    expect(audit.some((e) => e.action === 'emergency_confirmed')).toBe(true);
    // The connector now refuses new orders until the switch is cleared.
    const res = await provider.submitOrder({ clientOrderId: 'x', signalId: 's1', accountId: 'acc-1', symbol: 'XAUUSD', type: 'BUY_LIMIT', volume: 0.01, price: 4070, stopLoss: 4055, takeProfit: 4073 });
    expect(res.ok).toBe(false);
    await provider.clearEmergency();
    expect(db.emergency).toBe(false);
  });
});
