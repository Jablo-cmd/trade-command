/**
 * Supabase-backed repository for CONFIGURATION and AUDIT data.
 *
 * Synced to Supabase (RLS-protected, per user): servers, instrument specs, compatibility
 * profiles/items, accounts, risk settings, account snapshots, groups, memberships,
 * master signals, group entry plans, audit events.
 *
 * Kept in this browser only: simulator state and SIMULATED orders/fills/positions.
 * The orders/fills/positions tables are written exclusively by a future server-side
 * execution backend (clients have read-only access by design).
 *
 * NOTE: This adapter has been unit-tested against a fake client and the schema/RLS has
 * been tested on local PostgreSQL. It has not been exercised against a live Supabase
 * project in this repository.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { COMPATIBILITY_ITEMS, type CompatibilityProfile, type MasterSignal, type TradingAccount } from '../domain/types';
import { emptyData, type AppData } from './model';
import { LocalRepository, type Repository } from './repository';

type Row = Record<string, unknown>;

type Result = { error: { message: string } | null };
interface DeleteFilter extends PromiseLike<Result> {
  in(col: string, vals: string[]): DeleteFilter;
  eq(col: string, val: string): DeleteFilter;
}

/** Minimal surface of the Supabase query builder used here (eases testing). */
export interface DbClient {
  from(table: string): {
    select(cols?: string): PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;
    upsert(rows: Row[], opts?: { onConflict?: string }): PromiseLike<Result>;
    insert(rows: Row[]): PromiseLike<Result>;
    delete(): DeleteFilter;
  };
}

const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

// ---------------------------------------------------------------------------
// Mappers (pure; unit-tested)
// ---------------------------------------------------------------------------

export function accountToRows(a: TradingAccount) {
  return {
    account: {
      id: a.id,
      display_name: a.displayName,
      firm: a.firm,
      program: a.program,
      platform: a.platform,
      server_id: a.serverId ?? null,
      account_size: a.accountSize,
      currency: a.currency,
      trading_enabled: a.tradingEnabled,
      execution_mode: a.executionMode,
      instrument_permissions: a.instrumentPermissions,
      // Clients may only persist statuses they are allowed to claim.
      connection_status: a.connectionStatus === 'simulated' ? 'simulated' : 'not_configured',
      compatibility_profile_id: a.compatibilityProfileId ?? null,
      fx_rates: a.fxRates ?? {},
      notes: a.notes ?? null,
    },
    risk: {
      account_id: a.id,
      max_risk_per_trade: a.riskSettings.maxRiskPerTrade ?? null,
      daily_loss_limit: a.riskSettings.dailyLossLimit ?? null,
      max_total_drawdown: a.riskSettings.maxTotalDrawdown ?? null,
      max_volume: a.riskSettings.maxVolume ?? null,
      max_aggregate_risk: a.riskSettings.maxAggregateRisk ?? null,
      max_snapshot_age_minutes: a.riskSettings.maxSnapshotAgeMinutes,
    },
  };
}

export function rowsToAccount(r: Row, risk: Row | undefined, snap: Row | undefined): TradingAccount {
  return {
    id: String(r.id),
    displayName: String(r.display_name),
    firm: String(r.firm),
    program: String(r.program ?? ''),
    platform: r.platform as TradingAccount['platform'],
    serverId: s(r.server_id),
    accountSize: Number(r.account_size),
    currency: String(r.currency),
    tradingEnabled: Boolean(r.trading_enabled),
    executionMode: r.execution_mode as TradingAccount['executionMode'],
    instrumentPermissions: (r.instrument_permissions as string[]) ?? [],
    connectionStatus: r.connection_status as TradingAccount['connectionStatus'],
    compatibilityProfileId: s(r.compatibility_profile_id),
    fxRates: (r.fx_rates as TradingAccount['fxRates']) ?? {},
    notes: s(r.notes),
    riskSettings: {
      maxRiskPerTrade: n(risk?.max_risk_per_trade),
      dailyLossLimit: n(risk?.daily_loss_limit),
      maxTotalDrawdown: n(risk?.max_total_drawdown),
      maxVolume: n(risk?.max_volume),
      maxAggregateRisk: n(risk?.max_aggregate_risk),
      maxSnapshotAgeMinutes: n(risk?.max_snapshot_age_minutes) ?? 60,
    },
    snapshot: snap
      ? {
          balance: Number(snap.balance),
          equity: Number(snap.equity),
          dailyLossUsed: Number(snap.daily_loss_used),
          drawdownReference: Number(snap.drawdown_reference),
          source: snap.source as 'manual_entry',
          asOf: String(snap.as_of),
        }
      : undefined,
    createdAt: String(r.created_at ?? new Date().toISOString()),
    updatedAt: String(r.updated_at ?? new Date().toISOString()),
  };
}

export function signalToRows(sig: MasterSignal) {
  return {
    signal: {
      id: sig.id,
      symbol: sig.symbol,
      direction: sig.direction,
      reference_entry: sig.referenceEntry,
      strategy_pip_size: sig.strategy.strategyPipSize,
      default_tp_pips: sig.strategy.defaultTpPips,
      stop_loss_distance: sig.strategy.stopLossDistance,
      tp_mode: sig.takeProfit.kind,
      extended_tp_price: sig.takeProfit.kind === 'extended_absolute' ? sig.takeProfit.price : null,
      extended_tp_activated_at: sig.takeProfit.kind === 'extended_absolute' ? sig.takeProfit.activatedAt : null,
      status: sig.status,
      revision: sig.revision,
      notes: sig.notes ?? null,
    },
    plans: sig.groupPlans.map((g) => ({
      signal_id: sig.id,
      group_id: g.groupId,
      group_name: g.groupName,
      entry_offset: g.entryOffset,
      entry_price: g.entryPrice,
      order_kind: g.orderKind,
      staging_mode: g.stagingMode,
      require_approval: g.requireApproval,
      approved: g.approved,
    })),
  };
}

export function rowsToSignal(r: Row, plans: Row[]): MasterSignal {
  return {
    id: String(r.id),
    symbol: String(r.symbol),
    direction: r.direction as MasterSignal['direction'],
    referenceEntry: Number(r.reference_entry),
    strategy: { symbol: String(r.symbol), strategyPipSize: Number(r.strategy_pip_size), defaultTpPips: Number(r.default_tp_pips), stopLossDistance: Number(r.stop_loss_distance) },
    takeProfit:
      r.tp_mode === 'extended_absolute'
        ? { kind: 'extended_absolute', price: Number(r.extended_tp_price), activatedAt: String(r.extended_tp_activated_at) }
        : { kind: 'default_per_entry' },
    groupPlans: plans
      .filter((p) => p.signal_id === r.id)
      .sort((a, b) => Number(a.entry_offset) - Number(b.entry_offset))
      .map((p) => ({
        groupId: String(p.group_id),
        groupName: String(p.group_name),
        entryOffset: Number(p.entry_offset),
        entryPrice: Number(p.entry_price),
        orderKind: p.order_kind as 'limit' | 'market',
        stagingMode: p.staging_mode as 'manual' | 'automatic',
        requireApproval: Boolean(p.require_approval),
        approved: Boolean(p.approved),
      })),
    status: r.status as MasterSignal['status'],
    revision: Number(r.revision),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    notes: s(r.notes),
  };
}

export function profileItemsToRows(p: CompatibilityProfile): Row[] {
  return COMPATIBILITY_ITEMS.map((k) => ({
    profile_id: p.id,
    item_key: k,
    status: p.items[k].status,
    notes: p.items[k].notes ?? null,
    source: p.items[k].source ?? null,
    verified_on: p.items[k].verifiedOn ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SupabaseRepository implements Repository {
  readonly kind = 'supabase' as const;
  private local: LocalRepository;
  private known: Record<string, Set<string>> = {};
  private sentAudit = new Set<string>();
  private sentSnapshots = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  onError?: (message: string) => void;

  constructor(
    private readonly db: DbClient | SupabaseClient,
    userId: string,
    storage?: Storage,
  ) {
    // Local cache for simulator-only state, namespaced by user.
    this.local = new LocalRepository(storage ?? globalThis.localStorage, `trade-command:v1:${userId}`);
  }

  private get c(): DbClient {
    return this.db as unknown as DbClient;
  }

  private async sel(table: string): Promise<Row[]> {
    const { data, error } = await this.c.from(table).select('*');
    if (error) throw new Error(`${table}: ${error.message}`);
    return data ?? [];
  }

  async load(): Promise<AppData> {
    const localData = await this.local.load();
    const [servers, specs, profiles, items, accounts, risks, snaps, groups, members, signals, plans, audit] = await Promise.all(
      ['server_directory_entries', 'instrument_specs', 'compatibility_profiles', 'compatibility_items', 'trading_accounts', 'risk_settings', 'account_snapshots', 'account_groups', 'group_memberships', 'master_signals', 'group_entry_plans', 'audit_events'].map((t) => this.sel(t)),
    );
    const latestSnap = new Map<string, Row>();
    for (const sn of snaps!) {
      this.sentSnapshots.add(`${sn.account_id}:${new Date(String(sn.as_of)).toISOString()}`);
      const prev = latestSnap.get(String(sn.account_id));
      if (!prev || String(sn.as_of) > String(prev.as_of)) latestSnap.set(String(sn.account_id), sn);
    }
    for (const a of audit!) this.sentAudit.add(String(a.id));

    const data: AppData = {
      ...emptyData(),
      settings: localData.settings,
      execution: localData.execution,
      simulator: localData.simulator,
      servers: servers!.map((r) => ({
        id: String(r.id),
        firm: String(r.firm),
        serverName: String(r.server_name),
        platform: r.platform as 'MT5',
        origin: r.origin as 'custom',
        verification: { status: r.verification_status as 'verified', source: s(r.source), verifiedOn: s(r.verified_on) },
        notes: s(r.notes),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      })),
      specs: specs!.map((r) => ({
        id: String(r.id),
        serverId: String(r.server_id),
        symbol: String(r.symbol),
        tickSize: Number(r.tick_size),
        tickValue: Number(r.tick_value),
        contractSize: Number(r.contract_size),
        profitCurrency: String(r.profit_currency),
        volumeMin: Number(r.volume_min),
        volumeMax: Number(r.volume_max),
        volumeStep: Number(r.volume_step),
        minStopDistance: Number(r.min_stop_distance),
        commissionPerLot: n(r.commission_per_lot),
        verification: { status: r.verification_status as 'verified', source: s(r.source), verifiedOn: s(r.verified_on) },
        updatedAt: String(r.updated_at),
      })),
      profiles: profiles!.map((r) => {
        const its = Object.fromEntries(
          COMPATIBILITY_ITEMS.map((k) => {
            const it = items!.find((i) => i.profile_id === r.id && i.item_key === k);
            return [k, it ? { status: it.status, notes: s(it.notes), source: s(it.source), verifiedOn: s(it.verified_on) } : { status: 'unknown' }];
          }),
        ) as CompatibilityProfile['items'];
        return { id: String(r.id), firm: String(r.firm), program: String(r.program), items: its, updatedAt: String(r.updated_at) };
      }),
      accounts: accounts!.map((r) => rowsToAccount(r, risks!.find((x) => x.account_id === r.id), latestSnap.get(String(r.id)))),
      groups: groups!.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        sortOrder: Number(r.sort_order),
        enabled: Boolean(r.enabled),
        stagingMode: r.staging_mode as 'manual',
        entryOffset: Number(r.entry_offset),
        requireApproval: Boolean(r.require_approval),
        maxGroupRisk: n(r.max_group_risk),
        accountIds: members!.filter((m) => m.group_id === r.id).map((m) => String(m.account_id)),
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
      })),
      signals: signals!.map((r) => rowsToSignal(r, plans!)),
      audit: audit!
        .map((r) => ({ id: String(r.id), at: String(r.at), category: r.category as 'account', action: String(r.action), entityId: s(r.entity_id), message: String(r.message), details: (r.details as Row) ?? undefined, simulated: r.simulated as boolean | undefined }))
        .sort((a, b) => b.at.localeCompare(a.at)),
    };
    this.remember(data);
    return data;
  }

  private remember(d: AppData) {
    this.known = {
      server_directory_entries: new Set(d.servers.map((x) => x.id)),
      instrument_specs: new Set(d.specs.map((x) => x.id)),
      compatibility_profiles: new Set(d.profiles.map((x) => x.id)),
      trading_accounts: new Set(d.accounts.map((x) => x.id)),
      account_groups: new Set(d.groups.map((x) => x.id)),
      group_memberships: new Set(d.groups.flatMap((g) => g.accountIds.map((a) => `${g.id}|${a}`))),
      master_signals: new Set(d.signals.map((x) => x.id)),
    };
  }

  save(data: AppData): Promise<void> {
    // Serialise saves so FK ordering is preserved across rapid commits.
    this.queue = this.queue.then(() => this.doSave(data)).catch((e: unknown) => this.onError?.(`Cloud sync failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.queue;
  }

  private async up(table: string, rows: Row[], onConflict?: string) {
    if (!rows.length) return;
    const { error } = await this.c.from(table).upsert(rows, onConflict ? { onConflict } : undefined);
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  private async del(table: string, col: string, ids: string[]) {
    if (!ids.length) return;
    const { error } = await this.c.from(table).delete().in(col, ids);
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  private removed(table: string, current: string[]): string[] {
    const cur = new Set(current);
    return [...(this.known[table] ?? [])].filter((id) => !cur.has(id));
  }

  private async doSave(d: AppData) {
    await this.local.save({ ...emptyData(), settings: d.settings, execution: d.execution, simulator: d.simulator });

    // Deletes, children first.
    const goneMembers = this.removed('group_memberships', d.groups.flatMap((g) => g.accountIds.map((a) => `${g.id}|${a}`)));
    for (const key of goneMembers) {
      const [g, a] = key.split('|') as [string, string];
      const { error } = await this.c.from('group_memberships').delete().eq('group_id', g).eq('account_id', a);
      if (error) throw new Error(`group_memberships: ${error.message}`);
    }
    await this.del('master_signals', 'id', this.removed('master_signals', d.signals.map((x) => x.id)));
    await this.del('account_groups', 'id', this.removed('account_groups', d.groups.map((x) => x.id)));
    await this.del('trading_accounts', 'id', this.removed('trading_accounts', d.accounts.map((x) => x.id)));
    await this.del('instrument_specs', 'id', this.removed('instrument_specs', d.specs.map((x) => x.id)));
    await this.del('compatibility_profiles', 'id', this.removed('compatibility_profiles', d.profiles.map((x) => x.id)));
    await this.del('server_directory_entries', 'id', this.removed('server_directory_entries', d.servers.map((x) => x.id)));

    // Upserts, parents first.
    await this.up(
      'server_directory_entries',
      d.servers.map((x) => ({ id: x.id, firm: x.firm, server_name: x.serverName, platform: x.platform, origin: x.origin, verification_status: x.verification.status, source: x.verification.source ?? null, verified_on: x.verification.verifiedOn ?? null, notes: x.notes ?? null })),
    );
    await this.up(
      'instrument_specs',
      d.specs.map((x) => ({
        id: x.id,
        server_id: x.serverId,
        symbol: x.symbol,
        tick_size: x.tickSize,
        tick_value: x.tickValue,
        contract_size: x.contractSize,
        profit_currency: x.profitCurrency,
        volume_min: x.volumeMin,
        volume_max: x.volumeMax,
        volume_step: x.volumeStep,
        min_stop_distance: x.minStopDistance,
        commission_per_lot: x.commissionPerLot ?? null,
        verification_status: x.verification.status,
        source: x.verification.source ?? null,
        verified_on: x.verification.verifiedOn ?? null,
      })),
    );
    await this.up('compatibility_profiles', d.profiles.map((p) => ({ id: p.id, firm: p.firm, program: p.program })));
    await this.up('compatibility_items', d.profiles.flatMap(profileItemsToRows), 'profile_id,item_key');
    const acc = d.accounts.map(accountToRows);
    await this.up('trading_accounts', acc.map((x) => x.account));
    await this.up('risk_settings', acc.map((x) => x.risk), 'account_id');
    const newSnaps = d.accounts
      .filter((a) => a.snapshot && !this.sentSnapshots.has(`${a.id}:${new Date(a.snapshot.asOf).toISOString()}`))
      .map((a) => ({ account_id: a.id, balance: a.snapshot!.balance, equity: a.snapshot!.equity, daily_loss_used: a.snapshot!.dailyLossUsed, drawdown_reference: a.snapshot!.drawdownReference, source: a.snapshot!.source, as_of: a.snapshot!.asOf }));
    if (newSnaps.length) {
      const { error } = await this.c.from('account_snapshots').insert(newSnaps);
      if (error) throw new Error(`account_snapshots: ${error.message}`);
      for (const sn of newSnaps) this.sentSnapshots.add(`${sn.account_id}:${new Date(sn.as_of).toISOString()}`);
    }
    await this.up('account_groups', d.groups.map((g) => ({ id: g.id, name: g.name, sort_order: g.sortOrder, enabled: g.enabled, staging_mode: g.stagingMode, entry_offset: g.entryOffset, require_approval: g.requireApproval, max_group_risk: g.maxGroupRisk ?? null })));
    await this.up('group_memberships', d.groups.flatMap((g) => g.accountIds.map((a) => ({ group_id: g.id, account_id: a }))), 'group_id,account_id');
    const sig = d.signals.map(signalToRows);
    await this.up('master_signals', sig.map((x) => x.signal));
    await this.up('group_entry_plans', sig.flatMap((x) => x.plans), 'signal_id,group_id');

    const newAudit = d.audit.filter((e) => !this.sentAudit.has(e.id));
    if (newAudit.length) {
      const { error } = await this.c.from('audit_events').insert(newAudit.map((e) => ({ id: e.id, at: e.at, category: e.category, action: e.action, entity_id: e.entityId ?? null, message: e.message, details: e.details ?? null, simulated: e.simulated ?? null })));
      if (error) throw new Error(`audit_events: ${error.message}`);
      for (const e of newAudit) this.sentAudit.add(e.id);
    }
    this.remember(d);
  }
}
