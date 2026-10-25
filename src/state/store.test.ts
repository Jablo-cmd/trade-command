import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOLD_STRATEGY, MAX_ACCOUNTS } from '../domain/types';
import { MemoryRepository } from './repository';
import { Store, type AccountInput } from './store';

const NOW = new Date('2026-01-15T10:00:00.000Z');
let store: Store;
let repo: MemoryRepository;

const accountInput = (name: string, serverId?: string): AccountInput => ({
  displayName: name,
  firm: 'Example Firm',
  program: 'Example',
  platform: 'MT5',
  serverId,
  accountSize: 100000,
  currency: 'USD',
  tradingEnabled: true,
  executionMode: 'simulation',
  instrumentPermissions: ['xauusd'],
  riskSettings: { maxRiskPerTrade: 500, maxSnapshotAgeMinutes: 60 },
});

beforeEach(async () => {
  repo = new MemoryRepository();
  store = new Store(repo, { now: () => NOW });
  await store.init();
});

const data = () => store.getState().data;

describe('account, server and group workflows', () => {
  it('enforces the 40-account limit', () => {
    for (let i = 0; i < MAX_ACCOUNTS; i++) store.addAccount(accountInput(`acc ${i}`));
    expect(() => store.addAccount(accountInput('41'))).toThrow(/at most 40/);
    expect(data().accounts).toHaveLength(40);
  });

  it('normalises instrument permissions and audits changes', () => {
    const a = store.addAccount(accountInput('One'));
    expect(a.instrumentPermissions).toEqual(['XAUUSD']);
    expect(a.connectionStatus).toBe('simulated');
    store.updateAccount(a.id, { displayName: 'Renamed' });
    expect(data().audit[0]!.message).toMatch(/displayName/);
  });

  it('never lets the user set a connected status by changing mode', () => {
    const a = store.addAccount(accountInput('One'));
    store.updateAccount(a.id, { executionMode: 'live_automated' });
    expect(data().accounts[0]!.connectionStatus).toBe('not_configured');
  });

  it('manages custom server entries with verification rules', () => {
    expect(() => store.addServer({ firm: 'F', serverName: 'S', platform: 'MT5', origin: 'custom', verification: { status: 'verified' } })).toThrow(/source/);
    const s = store.addServer({ firm: 'F', serverName: 'S', platform: 'MT5', origin: 'custom', verification: { status: 'user_supplied' } });
    expect(() => store.addServer({ firm: 'f', serverName: 's', platform: 'MT5', origin: 'custom', verification: { status: 'user_supplied' } })).toThrow(/exists/);
    store.updateServer(s.id, { serverName: 'S2' });
    const a = store.addAccount(accountInput('One', s.id));
    expect(() => store.removeServer(s.id)).toThrow(/assigned/);
    store.removeAccount(a.id);
    store.removeServer(s.id);
    expect(data().servers).toHaveLength(0);
  });

  it('creates, reorders and configures groups', () => {
    const a = store.addGroup({ name: 'A', enabled: true, stagingMode: 'manual', entryOffset: 0, requireApproval: false, accountIds: [] });
    const b = store.addGroup({ name: 'B', enabled: true, stagingMode: 'manual', entryOffset: 3, requireApproval: true, accountIds: [] });
    store.moveGroup(b.id, -1);
    expect([...data().groups].sort((x, y) => x.sortOrder - y.sortOrder).map((g) => g.name)).toEqual(['B', 'A']);
    expect(() => store.updateGroup(a.id, { entryOffset: -1 })).toThrow();
    expect(() => store.addGroup({ name: 'a', enabled: true, stagingMode: 'manual', entryOffset: 1, requireApproval: false, accountIds: [] })).toThrow(/exists/);
  });

  it('rejects compatibility "permitted" without evidence', () => {
    const p = store.addProfile('F', 'P');
    expect(() => store.updateProfileItem(p.id, 'eaOrApi', { status: 'permitted' })).toThrow(/source/);
    store.updateProfileItem(p.id, 'eaOrApi', { status: 'permitted', source: 'https://example.test/rules', verifiedOn: '2026-01-10' });
    expect(data().profiles[0]!.items.eaOrApi.status).toBe('permitted');
  });

  it('persists to the repository', async () => {
    store.addAccount(accountInput('Persisted'));
    const reloaded = new Store(repo, { now: () => NOW });
    await reloaded.init();
    expect(reloaded.getState().data.accounts[0]!.displayName).toBe('Persisted');
  });
});

describe('signal workflow through the simulator', () => {
  beforeEach(() => store.loadDemoData());

  it('demo data is clearly labelled and unverified', () => {
    expect(data().accounts.every((a) => a.displayName.startsWith('DEMO'))).toBe(true);
    expect(data().specs[0]!.verification.status).toBe('user_supplied');
    expect(Object.values(data().profiles[0]!.items).every((i) => i.status === 'unknown')).toBe(true);
  });

  it('blocks limits until a simulated quote exists, then submits, fills and closes', async () => {
    const sig = store.createSignal({ symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: DEFAULT_GOLD_STRATEGY, groupIds: data().groups.map((g) => g.id), marketForZeroOffset: false });
    let plan = await store.previewPlan(sig.id);
    expect(plan.every((p) => p.status === 'blocked')).toBe(true);
    expect(plan[0]!.blockers.join()).toMatch(/market price is unknown/);

    await store.setSimulatedQuote('XAUUSD', 4080.3, 4080.5, true);
    plan = await store.previewPlan(sig.id);
    expect(plan.map((p) => p.entryPrice)).toEqual([4080, 4077, 4075, 4073, 4071]);
    expect(plan.every((p) => p.status === 'ready')).toBe(true);
    // Unverified spec is allowed in simulation but flagged.
    expect(plan[0]!.warnings.join()).toMatch(/not verified/);

    await store.submitSignal(sig.id);
    expect(data().execution.orders).toHaveLength(5);
    expect(data().signals[0]!.status).toBe('active');

    await store.setSimulatedQuote('XAUUSD', 4079.7, 4079.9, true);
    expect(data().execution.positions).toHaveLength(1);

    await store.activateExtended(sig.id, 4149);
    expect(data().execution.positions[0]!.takeProfit).toBe(4149);
    expect(data().execution.positions[0]!.stopLoss).toBe(4065);
    expect(data().signals[0]!.takeProfit).toMatchObject({ kind: 'extended_absolute', price: 4149 });

    await store.cancelSignal(sig.id);
    expect(data().execution.orders.filter((o) => o.state === 'cancelled')).toHaveLength(4);
    // An open position remains, so the signal stays active until it closes.
    expect(data().signals[0]!.status).toBe('active');
    await store.setSimulatedQuote('XAUUSD', 4149.1, 4149.3, true);
    expect(data().execution.positions[0]!.status).toBe('closed');
    expect(data().signals[0]!.status).toBe('closed');
  });

  it('emergency disable cancels working orders and blocks new plans', async () => {
    await store.setSimulatedQuote('XAUUSD', 4080.3, 4080.5, true);
    const sig = store.createSignal({ symbol: 'XAUUSD', direction: 'SELL', referenceEntry: 4081, strategy: DEFAULT_GOLD_STRATEGY, groupIds: data().groups.map((g) => g.id), marketForZeroOffset: false });
    await store.submitSignal(sig.id);
    await store.emergencyDisable();
    expect(data().execution.orders.every((o) => o.state === 'cancelled')).toBe(true);
    const plan = await store.previewPlan(sig.id);
    expect(plan.every((p) => p.status !== 'ready')).toBe(true);
    expect(data().audit.some((e) => e.action === 'emergency_disable')).toBe(true);
  });

  it('with the MT5 provider selected, everything is blocked and nothing is sent', async () => {
    store.setProvider('mt5_unavailable');
    const sig = store.createSignal({ symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: DEFAULT_GOLD_STRATEGY, groupIds: data().groups.map((g) => g.id), marketForZeroOffset: false });
    const plan = await store.previewPlan(sig.id);
    expect(plan.every((p) => p.status === 'blocked')).toBe(true);
    await expect(store.submitSignal(sig.id)).rejects.toThrow(/No ready orders/);
    expect(data().execution.orders).toHaveLength(0);
  });

  it('manual staging: submits only the chosen group, then later groups separately', async () => {
    await store.setSimulatedQuote('XAUUSD', 4080.3, 4080.5, true);
    const gs = data().groups;
    const sig = store.createSignal({ symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: DEFAULT_GOLD_STRATEGY, groupIds: gs.map((g) => g.id), marketForZeroOffset: false });
    await store.submitSignal(sig.id, [gs[0]!.id]);
    expect(data().execution.orders).toHaveLength(1);
    await store.submitSignal(sig.id, [gs[1]!.id]);
    expect(data().execution.orders).toHaveLength(2);
    // Re-submitting group A is a no-op (duplicate prevented at plan level).
    await expect(store.submitSignal(sig.id, [gs[0]!.id])).rejects.toThrow(/No ready orders/);
  });
});

describe('live MT5 connector mode', () => {
  it('uses the connector heartbeat for connection, balances and quotes; blocks when it goes stale', async () => {
    const { ConnectorProvider } = await import('../execution/connectorProvider');
    const hb = {
      account_id: '', terminal_connected: true, login_verified: true, trade_mode: 'demo', balance: 100000, equity: 100000,
      daily_loss_used: 0, currency: 'USD', last_seen: NOW.toISOString(), quotes: { XAUUSD: { bid: 4080.3, ask: 4080.5, time: NOW.toISOString() } },
    };
    const fakeDb = {
      insertCommand: async () => ({ data: null, error: { message: 'not used' } }),
      getCommand: async () => ({ data: null, error: null }),
      findSubmit: async () => ({ data: null, error: null }),
      list: async (t: string) => ({ data: t === 'connector_heartbeats' ? [hb] : [], error: null }),
      setEmergency: async () => ({ data: null, error: null }),
    };
    const connector = new ConnectorProvider(fakeDb, { now: () => NOW.getTime() });
    const live = new Store(new MemoryRepository(), { now: () => NOW, connector });
    await live.init();
    live.loadDemoData();
    const d = () => live.getState().data;
    const acc = d().accounts[0]!;
    hb.account_id = acc.id;
    live.updateAccount(acc.id, { executionMode: 'live_automated' });
    const spec = d().specs[0]!;
    live.upsertSpec({ ...spec, verification: { status: 'verified', source: 'MT5 symbol specification', verifiedOn: '2026-01-14' } });
    for (const k of Object.keys(d().profiles[0]!.items)) {
      live.updateProfileItem(d().profiles[0]!.id, k as never, { status: 'permitted', source: 'https://ftmo.com/en/faq/', verifiedOn: '2026-01-10' });
    }
    live.setProvider('mt5_connector');
    const groupA = d().groups.find((g) => g.accountIds.includes(acc.id))!;
    const sig = live.createSignal({ symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4077, strategy: DEFAULT_GOLD_STRATEGY, groupIds: [groupA.id], marketForZeroOffset: false });

    let plan = await live.previewPlan(sig.id);
    expect(plan[0]!.status).toBe('ready');
    expect(live.liveState(acc.id)).toMatchObject({ connection: 'connected', tradeMode: 'demo' });

    hb.last_seen = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    plan = await live.previewPlan(sig.id);
    expect(plan[0]!.status).toBe('blocked');
    expect(plan[0]!.blockers.join()).toMatch(/connection is disconnected/);
  });
});
