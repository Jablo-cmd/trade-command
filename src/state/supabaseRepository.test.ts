import { describe, expect, it } from 'vitest';
import { createSignal } from '../domain/signal';
import { NOW_ISO, STRATEGY, account, group } from '../test/fixtures';
import { emptyData } from './model';
import { accountToRows, rowsToAccount, rowsToSignal, signalToRows, SupabaseRepository, type DbClient } from './supabaseRepository';

function fakeDb() {
  const calls: string[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {};
  const ok = Promise.resolve({ error: null });
  const filter = (t: string): ReturnType<ReturnType<DbClient['from']>['delete']> => {
    const f = Object.assign(ok, { in: () => (calls.push(`delete:${t}`), f), eq: () => (calls.push(`delete:${t}`), f) });
    return f;
  };
  const db: DbClient = {
    from: (t) => ({
      select: () => Promise.resolve({ data: tables[t] ?? [], error: null }),
      upsert: (rows) => (calls.push(`upsert:${t}:${rows.length}`), ok),
      insert: (rows) => (calls.push(`insert:${t}:${rows.length}`), ok),
      delete: () => filter(t),
    }),
  };
  return { db, calls, tables };
}

const memStorage = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 };
};

describe('Supabase mappers', () => {
  it('round-trips an account with risk settings and snapshot', () => {
    const a = account({ riskSettings: { maxRiskPerTrade: 500, dailyLossLimit: 2000, maxSnapshotAgeMinutes: 30 }, fxRates: { USD: { rate: 0.9, asOf: NOW_ISO } } });
    const rows = accountToRows(a);
    const snap = { account_id: a.id, balance: 1, equity: 2, daily_loss_used: 0, drawdown_reference: 3, source: 'manual_entry', as_of: NOW_ISO };
    const back = rowsToAccount({ ...rows.account, created_at: a.createdAt, updated_at: a.updatedAt }, rows.risk, snap);
    expect(back).toMatchObject({ ...a, snapshot: { balance: 1, equity: 2, dailyLossUsed: 0, drawdownReference: 3, source: 'manual_entry', asOf: NOW_ISO } });
  });

  it('never persists a claimed broker connection from the client', () => {
    expect(accountToRows(account({ connectionStatus: 'connected' })).account.connection_status).toBe('not_configured');
    expect(accountToRows(account({ connectionStatus: 'simulated' })).account.connection_status).toBe('simulated');
  });

  it('round-trips a signal with extended TP and group plans', () => {
    const sig = createSignal('s1', { symbol: 'XAUUSD', direction: 'BUY', referenceEntry: 4080, strategy: STRATEGY, extendedTp: 4149, groupIds: ['A', 'B'], marketForZeroOffset: false }, [group({ id: 'A' }), group({ id: 'B', name: 'B', entryOffset: 3, sortOrder: 1 })], 0.01, NOW_ISO);
    const rows = signalToRows(sig);
    expect(rows.signal.extended_tp_price).toBe(4149);
    const back = rowsToSignal({ ...rows.signal, created_at: sig.createdAt, updated_at: sig.updatedAt }, rows.plans);
    expect(back).toEqual(sig);
  });
});

describe('SupabaseRepository.save', () => {
  it('writes parents before children and sends audit events once', async () => {
    const { db, calls } = fakeDb();
    const repo = new SupabaseRepository(db, 'user-1', memStorage());
    await repo.load();
    const data = { ...emptyData(), accounts: [account()], groups: [group()], audit: [{ id: 'e1', at: NOW_ISO, category: 'account' as const, action: 'x', message: 'm' }] };
    await repo.save(data);
    const order = (t: string) => calls.findIndex((c) => c.startsWith(`upsert:${t}`));
    expect(order('server_directory_entries')).toBeLessThan(order('trading_accounts'));
    expect(order('trading_accounts')).toBeLessThan(order('risk_settings'));
    expect(order('account_groups')).toBeLessThan(order('group_memberships'));
    expect(calls).toContain('insert:audit_events:1');
    calls.length = 0;
    await repo.save(data);
    expect(calls.some((c) => c.startsWith('insert:audit_events'))).toBe(false);
  });

  it('deletes rows that were removed locally', async () => {
    const { db, calls } = fakeDb();
    const repo = new SupabaseRepository(db, 'user-1', memStorage());
    await repo.load();
    await repo.save({ ...emptyData(), accounts: [account()], groups: [group()] });
    calls.length = 0;
    await repo.save({ ...emptyData(), accounts: [account()], groups: [] });
    expect(calls).toContain('delete:account_groups');
    expect(calls).toContain('delete:group_memberships');
    expect(calls).not.toContain('delete:trading_accounts');
  });
});
