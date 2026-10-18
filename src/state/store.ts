/**
 * Application store. Holds AppData, exposes audited actions, and owns the active
 * execution provider + orchestrator. UI components subscribe via useSyncExternalStore.
 */
import { createAuditEvent } from '../domain/audit';
import { emptyCompatibilityProfile } from '../domain/compatibility';
import { activateExtendedTp, previewExtendedTp, previewResetTp, resetExtendedTp, setupIsClosed, type ExtendedTpPreview } from '../domain/extendedTp';
import { buildExecutionPlan, findSpec, type PlannedOrder } from '../domain/plan';
import type { MarketContext } from '../domain/staging';
import { approveGroup, createSignal, type SignalDraft } from '../domain/signal';
import {
  MAX_ACCOUNTS,
  type AccountGroup,
  type AccountSnapshot,
  type AuditCategory,
  type CompatibilityItem,
  type CompatibilityItemKey,
  type InstrumentSpec,
  type MasterSignal,
  type ServerDirectoryEntry,
  type StrategyConfig,
  type TradingAccount,
} from '../domain/types';
import { ExecutionOrchestrator } from '../execution/orchestrator';
import type { ExecutionProvider } from '../execution/provider';
import { SimulatedExecutionProvider, type SimulatorFaults } from '../execution/simulator';
import { UnavailableMt5Provider } from '../execution/unavailableProvider';
import { buildDemoData } from './demo';
import { emptyData, type AppData, type ProviderChoice } from './model';
import type { Repository } from './repository';

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for non-secure contexts (e.g. LAN testing over http).
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface StoreState {
  ready: boolean;
  busy: boolean;
  error?: string;
  data: AppData;
}

export type AccountInput = Omit<TradingAccount, 'id' | 'createdAt' | 'updatedAt' | 'connectionStatus'>;
export type ServerInput = Omit<ServerDirectoryEntry, 'id' | 'createdAt' | 'updatedAt'>;
export type GroupInput = Omit<AccountGroup, 'id' | 'createdAt' | 'updatedAt' | 'sortOrder'>;
export type SpecInput = Omit<InstrumentSpec, 'id' | 'updatedAt'>;

export class Store {
  private state: StoreState = { ready: false, busy: false, data: emptyData() };
  private listeners = new Set<() => void>();
  private sim = new SimulatedExecutionProvider();
  private readonly mt5 = new UnavailableMt5Provider();
  private readonly nowFn: () => Date;

  constructor(
    private readonly repo: Repository,
    opts: { now?: () => Date } = {},
  ) {
    this.nowFn = opts.now ?? (() => new Date());
  }

  // ---- subscription -------------------------------------------------------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  private emit() {
    for (const l of this.listeners) l();
  }
  private get data() {
    return this.state.data;
  }
  private nowIso() {
    return this.nowFn().toISOString();
  }

  private commit(data: AppData, extra: Partial<StoreState> = {}) {
    const snapshot = this.sim.snapshot();
    const next = { ...data, simulator: snapshot };
    this.state = { ...this.state, ...extra, data: next };
    this.emit();
    void this.repo.save(next);
  }

  private audit(data: AppData, category: AuditCategory, action: string, message: string, entityId?: string, details?: Record<string, unknown>, simulated?: boolean): AppData {
    const e = createAuditEvent(newId(), this.nowIso(), category, action, message, { entityId, details, simulated });
    return { ...data, audit: [e, ...data.audit].slice(0, 5000) };
  }

  private fail(message: string): never {
    this.state = { ...this.state, error: message };
    this.emit();
    throw new Error(message);
  }

  reportError = (message: string) => {
    this.state = { ...this.state, error: message };
    this.emit();
  };

  clearError() {
    this.state = { ...this.state, error: undefined };
    this.emit();
  }

  async init() {
    const data = await this.repo.load();
    this.sim = new SimulatedExecutionProvider({ now: () => this.nowIso() });
    if (data.simulator) this.sim.restore(data.simulator);
    this.state = { ready: true, busy: false, data };
    this.emit();
  }

  // ---- provider -----------------------------------------------------------
  get provider(): ExecutionProvider {
    return this.data.settings.provider === 'simulator' ? this.sim : this.mt5;
  }
  get simulator(): SimulatedExecutionProvider {
    return this.sim;
  }
  private makeOrchestrator(collect: (e: AppData['audit'][number]) => void) {
    return new ExecutionOrchestrator({
      provider: this.provider,
      newId,
      now: () => this.nowIso(),
      audit: collect,
      tickSizeFor: (accountId, symbol) => this.specForAccount(accountId, symbol)?.tickSize ?? 0.01,
      accountName: (id) => this.data.accounts.find((a) => a.id === id)?.displayName ?? 'Unknown account',
    });
  }

  /** Run an orchestrator operation and merge its audit events + execution state. */
  private async runExecution(fn: (o: ExecutionOrchestrator) => Promise<AppData['execution']>, mutate?: (d: AppData) => AppData) {
    const events: AppData['audit'] = [];
    const o = this.makeOrchestrator((e) => events.push(e));
    this.state = { ...this.state, busy: true, error: undefined };
    this.emit();
    try {
      const execution = await fn(o);
      let d: AppData = { ...this.data, execution, audit: [...events.reverse(), ...this.data.audit] };
      if (mutate) d = mutate(d);
      d = this.autoCloseSignals(d);
      this.commit(d, { busy: false });
    } catch (e) {
      const d = { ...this.data, audit: [...events.reverse(), ...this.data.audit] };
      this.commit(d, { busy: false, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  private autoCloseSignals(d: AppData): AppData {
    let out = d;
    for (const s of d.signals) {
      if (s.status === 'active' && setupIsClosed(s, d.execution.orders, d.execution.positions)) {
        out = { ...out, signals: out.signals.map((x) => (x.id === s.id ? { ...x, status: 'closed' as const, updatedAt: this.nowIso() } : x)) };
        out = this.audit(out, 'signal', 'closed', `Setup ${s.symbol} ${s.direction} closed: no working orders or open positions.`, s.id);
      }
    }
    return out;
  }

  specForAccount(accountId: string, symbol: string): InstrumentSpec | undefined {
    const a = this.data.accounts.find((x) => x.id === accountId);
    return findSpec(this.data.specs, a?.serverId, symbol);
  }

  // ---- accounts -----------------------------------------------------------
  addAccount(input: AccountInput): TradingAccount {
    if (this.data.accounts.length >= MAX_ACCOUNTS) this.fail(`V1 supports at most ${MAX_ACCOUNTS} accounts.`);
    if (!input.displayName.trim()) this.fail('Display name is required.');
    const now = this.nowIso();
    const acc: TradingAccount = {
      ...input,
      id: newId(),
      instrumentPermissions: input.instrumentPermissions.map((s) => s.trim().toUpperCase()).filter(Boolean),
      connectionStatus: input.executionMode === 'simulation' ? 'simulated' : 'not_configured',
      createdAt: now,
      updatedAt: now,
    };
    const d = this.audit({ ...this.data, accounts: [...this.data.accounts, acc] }, 'account', 'created', `Account "${acc.displayName}" created.`, acc.id, {
      firm: acc.firm,
      program: acc.program,
      executionMode: acc.executionMode,
    });
    this.commit(d);
    return acc;
  }

  updateAccount(id: string, patch: Partial<AccountInput>) {
    const prev = this.data.accounts.find((a) => a.id === id);
    if (!prev) this.fail('Account not found.');
    const next: TradingAccount = {
      ...prev,
      ...patch,
      instrumentPermissions: (patch.instrumentPermissions ?? prev.instrumentPermissions).map((s) => s.trim().toUpperCase()).filter(Boolean),
      updatedAt: this.nowIso(),
    };
    // Connection status reflects the provider, not user input.
    next.connectionStatus = next.executionMode === 'simulation' ? 'simulated' : prev.connectionStatus === 'simulated' ? 'not_configured' : prev.connectionStatus;
    const changed = Object.keys(patch).filter((k) => JSON.stringify((prev as unknown as Record<string, unknown>)[k]) !== JSON.stringify((next as unknown as Record<string, unknown>)[k]));
    const d = this.audit({ ...this.data, accounts: this.data.accounts.map((a) => (a.id === id ? next : a)) }, 'account', 'updated', `Account "${next.displayName}" updated (${changed.join(', ') || 'no changes'}).`, id, {
      changed,
    });
    this.commit(d);
  }

  setSnapshot(id: string, snap: Omit<AccountSnapshot, 'asOf' | 'source'>) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) this.fail('Account not found.');
    const snapshot: AccountSnapshot = { ...snap, source: 'manual_entry', asOf: this.nowIso() };
    const d = this.audit(
      { ...this.data, accounts: this.data.accounts.map((a) => (a.id === id ? { ...a, snapshot, updatedAt: this.nowIso() } : a)) },
      'risk',
      'snapshot_entered',
      `Manual balance/equity snapshot entered for "${acc.displayName}".`,
      id,
      { ...snap },
    );
    this.commit(d);
  }

  setFxRate(id: string, currency: string, rate: number) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) this.fail('Account not found.');
    if (!(rate > 0)) this.fail('Rate must be positive.');
    const fxRates = { ...acc.fxRates, [currency.toUpperCase()]: { rate, asOf: this.nowIso() } };
    const d = this.audit({ ...this.data, accounts: this.data.accounts.map((a) => (a.id === id ? { ...a, fxRates } : a)) }, 'risk', 'fx_rate_set', `${currency}→${acc.currency} rate set to ${rate} for "${acc.displayName}".`, id);
    this.commit(d);
  }

  removeAccount(id: string) {
    const acc = this.data.accounts.find((a) => a.id === id);
    if (!acc) return;
    const working = this.data.execution.orders.some((o) => o.accountId === id && ['acknowledged', 'submitted', 'partially_filled', 'unknown', 'cancel_requested', 'pending_submission'].includes(o.state));
    const open = this.data.execution.positions.some((p) => p.accountId === id && p.status === 'open');
    if (working || open) this.fail('Account has working orders or open positions; cancel/close them first.');
    const d = this.audit(
      {
        ...this.data,
        accounts: this.data.accounts.filter((a) => a.id !== id),
        groups: this.data.groups.map((g) => ({ ...g, accountIds: g.accountIds.filter((x) => x !== id) })),
      },
      'account',
      'removed',
      `Account "${acc.displayName}" removed.`,
      id,
    );
    this.commit(d);
  }

  // ---- servers & specs ----------------------------------------------------
  addServer(input: ServerInput): ServerDirectoryEntry {
    if (!input.firm.trim() || !input.serverName.trim()) this.fail('Firm and server name are required.');
    if (input.verification.status === 'verified' && (!input.verification.source || !input.verification.verifiedOn)) {
      this.fail('A verified entry needs a source and verification date.');
    }
    const dup = this.data.servers.some((s) => s.firm.toLowerCase() === input.firm.trim().toLowerCase() && s.serverName.toLowerCase() === input.serverName.trim().toLowerCase());
    if (dup) this.fail('This firm/server entry already exists.');
    const now = this.nowIso();
    const s: ServerDirectoryEntry = { ...input, firm: input.firm.trim(), serverName: input.serverName.trim(), id: newId(), createdAt: now, updatedAt: now };
    this.commit(this.audit({ ...this.data, servers: [...this.data.servers, s] }, 'server', 'created', `Server "${s.serverName}" (${s.firm}) added as ${s.verification.status}.`, s.id));
    return s;
  }

  updateServer(id: string, patch: Partial<ServerInput>) {
    const prev = this.data.servers.find((s) => s.id === id);
    if (!prev) this.fail('Server not found.');
    const next = { ...prev, ...patch, updatedAt: this.nowIso() };
    if (next.verification.status === 'verified' && (!next.verification.source || !next.verification.verifiedOn)) {
      this.fail('A verified entry needs a source and verification date.');
    }
    this.commit(this.audit({ ...this.data, servers: this.data.servers.map((s) => (s.id === id ? next : s)) }, 'server', 'updated', `Server "${next.serverName}" updated.`, id));
  }

  removeServer(id: string) {
    const s = this.data.servers.find((x) => x.id === id);
    if (!s) return;
    if (this.data.accounts.some((a) => a.serverId === id)) this.fail('Server is assigned to accounts; reassign them first.');
    this.commit(
      this.audit(
        { ...this.data, servers: this.data.servers.filter((x) => x.id !== id), specs: this.data.specs.filter((x) => x.serverId !== id) },
        'server',
        'removed',
        `Server "${s.serverName}" removed.`,
        id,
      ),
    );
  }

  upsertSpec(input: SpecInput & { id?: string }) {
    const errs: string[] = [];
    if (!(input.tickSize > 0)) errs.push('tick size');
    if (!(input.tickValue > 0)) errs.push('tick value');
    if (!(input.volumeStep > 0)) errs.push('volume step');
    if (!(input.volumeMin > 0)) errs.push('min volume');
    if (!(input.volumeMax >= input.volumeMin)) errs.push('max volume');
    if (!(input.minStopDistance >= 0)) errs.push('min stop distance');
    if (errs.length) this.fail(`Invalid instrument specification: ${errs.join(', ')}.`);
    if (input.verification.status === 'verified' && (!input.verification.source || !input.verification.verifiedOn)) {
      this.fail('A verified specification needs a source and verification date.');
    }
    const symbol = input.symbol.trim().toUpperCase();
    const existing = this.data.specs.find((s) => s.id === input.id || (s.serverId === input.serverId && s.symbol === symbol));
    const spec: InstrumentSpec = { ...input, symbol, id: existing?.id ?? newId(), updatedAt: this.nowIso() };
    const specs = existing ? this.data.specs.map((s) => (s.id === existing.id ? spec : s)) : [...this.data.specs, spec];
    this.commit(this.audit({ ...this.data, specs }, 'settings', existing ? 'spec_updated' : 'spec_created', `${symbol} specification ${existing ? 'updated' : 'added'} (${spec.verification.status}).`, spec.id, { ...spec }));
  }

  removeSpec(id: string) {
    this.commit(this.audit({ ...this.data, specs: this.data.specs.filter((s) => s.id !== id) }, 'settings', 'spec_removed', 'Instrument specification removed.', id));
  }

  // ---- compatibility ------------------------------------------------------
  addProfile(firm: string, program: string) {
    if (!firm.trim() || !program.trim()) this.fail('Firm and program are required.');
    const p = emptyCompatibilityProfile(newId(), firm.trim(), program.trim(), this.nowIso());
    this.commit(this.audit({ ...this.data, profiles: [...this.data.profiles, p] }, 'compatibility', 'created', `Compatibility profile ${p.firm} / ${p.program} created (all rules unknown).`, p.id));
    return p;
  }

  updateProfileItem(id: string, key: CompatibilityItemKey, item: CompatibilityItem) {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) this.fail('Profile not found.');
    if ((item.status === 'permitted' || item.status === 'conditional') && (!item.source?.trim() || !item.verifiedOn)) {
      this.fail('Permitted/conditional requires a source and verification date.');
    }
    const next = { ...p, items: { ...p.items, [key]: item }, updatedAt: this.nowIso() };
    this.commit(
      this.audit({ ...this.data, profiles: this.data.profiles.map((x) => (x.id === id ? next : x)) }, 'compatibility', 'item_updated', `${p.firm} / ${p.program}: ${key} → ${item.status}.`, id, {
        key,
        ...item,
      }),
    );
  }

  removeProfile(id: string) {
    this.commit(
      this.audit(
        {
          ...this.data,
          profiles: this.data.profiles.filter((p) => p.id !== id),
          accounts: this.data.accounts.map((a) => (a.compatibilityProfileId === id ? { ...a, compatibilityProfileId: undefined } : a)),
        },
        'compatibility',
        'removed',
        'Compatibility profile removed.',
        id,
      ),
    );
  }

  // ---- groups -------------------------------------------------------------
  addGroup(input: GroupInput): AccountGroup {
    if (!input.name.trim()) this.fail('Group name is required.');
    if (this.data.groups.some((g) => g.name.toLowerCase() === input.name.trim().toLowerCase())) this.fail('A group with this name exists.');
    if (!(input.entryOffset >= 0)) this.fail('Offset must be zero or positive.');
    const now = this.nowIso();
    const g: AccountGroup = { ...input, name: input.name.trim(), id: newId(), sortOrder: this.data.groups.length, createdAt: now, updatedAt: now };
    this.commit(this.audit({ ...this.data, groups: [...this.data.groups, g] }, 'group', 'created', `Group "${g.name}" created (offset ${g.entryOffset}).`, g.id));
    return g;
  }

  updateGroup(id: string, patch: Partial<GroupInput>) {
    const prev = this.data.groups.find((g) => g.id === id);
    if (!prev) this.fail('Group not found.');
    if (patch.name !== undefined && this.data.groups.some((g) => g.id !== id && g.name.toLowerCase() === patch.name!.trim().toLowerCase())) this.fail('A group with this name exists.');
    if (patch.entryOffset !== undefined && !(patch.entryOffset >= 0)) this.fail('Offset must be zero or positive.');
    const next = { ...prev, ...patch, updatedAt: this.nowIso() };
    this.commit(this.audit({ ...this.data, groups: this.data.groups.map((g) => (g.id === id ? next : g)) }, 'group', 'updated', `Group "${next.name}" updated.`, id, { ...patch }));
  }

  moveGroup(id: string, delta: -1 | 1) {
    const sorted = [...this.data.groups].sort((a, b) => a.sortOrder - b.sortOrder);
    const i = sorted.findIndex((g) => g.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= sorted.length) return;
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
    const groups = sorted.map((g, k) => ({ ...g, sortOrder: k }));
    this.commit(this.audit({ ...this.data, groups }, 'group', 'reordered', `Group order: ${groups.map((g) => g.name).join(' → ')}.`, id));
  }

  removeGroup(id: string) {
    const g = this.data.groups.find((x) => x.id === id);
    if (!g) return;
    this.commit(this.audit({ ...this.data, groups: this.data.groups.filter((x) => x.id !== id).map((x, k) => ({ ...x, sortOrder: k })) }, 'group', 'removed', `Group "${g.name}" removed.`, id));
  }

  // ---- signals ------------------------------------------------------------
  signalTickSize(groupIds: string[], symbol: string): number {
    const accIds = new Set(this.data.groups.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.accountIds));
    const ticks = [...accIds].map((id) => this.specForAccount(id, symbol)?.tickSize).filter((t): t is number => t !== undefined);
    return ticks.length ? Math.max(...ticks) : 0.01;
  }

  createSignal(draft: SignalDraft): MasterSignal {
    let sig: MasterSignal;
    try {
      sig = createSignal(newId(), draft, this.data.groups, this.signalTickSize(draft.groupIds, draft.symbol), this.nowIso());
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
    this.commit(
      this.audit({ ...this.data, signals: [sig, ...this.data.signals] }, 'signal', 'created', `Signal ${sig.direction} ${sig.symbol} @ ${sig.referenceEntry} created (${sig.groupPlans.length} groups).`, sig.id, {
        direction: sig.direction,
        referenceEntry: sig.referenceEntry,
        takeProfit: sig.takeProfit,
        groups: sig.groupPlans.map((g) => ({ name: g.groupName, entry: g.entryPrice, kind: g.orderKind })),
        strategy: sig.strategy,
      }),
    );
    return sig;
  }

  approveSignalGroup(signalId: string, groupId: string) {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) this.fail('Signal not found.');
    const next = approveGroup(s, groupId, this.nowIso());
    const name = s.groupPlans.find((g) => g.groupId === groupId)?.groupName;
    this.commit(this.audit({ ...this.data, signals: this.data.signals.map((x) => (x.id === signalId ? next : x)) }, 'signal', 'group_approved', `Group ${name} approved for execution.`, signalId));
  }

  async market(symbol: string): Promise<MarketContext> {
    const r = await this.provider.getMarket(symbol);
    return r.ok ? r.value : {};
  }

  async previewPlan(signalId: string): Promise<PlannedOrder[]> {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) return [];
    const market = await this.market(s.symbol);
    return buildExecutionPlan(s, {
      accounts: this.data.accounts,
      groups: this.data.groups,
      specs: this.data.specs,
      profiles: this.data.profiles,
      orders: this.data.execution.orders,
      positions: this.data.execution.positions,
      context: this.provider.info.simulated ? 'simulation' : 'live',
      emergencyDisabled: this.data.settings.emergencyDisabled,
      market,
      now: this.nowFn(),
    });
  }

  /** Authorise and submit ready orders for the given groups (all groups if omitted). */
  async submitSignal(signalId: string, groupIds?: string[]) {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) this.fail('Signal not found.');
    if (s.status === 'closed' || s.status === 'cancelled') this.fail('Signal is no longer active.');
    const plan = (await this.previewPlan(signalId)).filter((p) => !groupIds || groupIds.includes(p.groupId));
    const ready = plan.filter((p) => p.status === 'ready');
    if (!ready.length) this.fail('No ready orders to submit.');
    this.commit(
      this.audit(this.data, 'signal', 'authorized', `User authorised ${ready.length} order(s) for ${s.symbol} ${s.direction} via ${this.provider.info.name}.`, signalId, {
        orders: ready.map((p) => ({ account: p.accountName, group: p.groupName, volume: p.risk?.volume, entry: p.entryPrice })),
      }, this.provider.info.simulated),
    );
    await this.runExecution(
      (o) => o.submit(s, ready, this.data.execution, { emergencyDisabled: this.data.settings.emergencyDisabled }),
      (d) => ({ ...d, signals: d.signals.map((x) => (x.id === signalId ? { ...x, status: 'active' as const, updatedAt: this.nowIso() } : x)) }),
    );
  }

  async cancelSignal(signalId: string) {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) return;
    await this.runExecution(
      (o) => o.cancelAllForSignal(signalId, this.data.execution, 'signal cancelled'),
      (d) => {
        const open = d.execution.positions.some((p) => p.signalId === signalId && p.status === 'open');
        const status = open ? s.status : ('cancelled' as const);
        const out = { ...d, signals: d.signals.map((x) => (x.id === signalId ? { ...x, status, updatedAt: this.nowIso() } : x)) };
        return this.audit(out, 'signal', 'cancelled', `Signal cancelled: pending orders cancelled${open ? '; open positions remain under their SL/TP' : ''}.`, signalId);
      },
    );
  }

  async cancelOrder(clientOrderId: string) {
    await this.runExecution((o) => o.cancel(clientOrderId, this.data.execution, 'user request'));
  }

  async reconcile() {
    await this.runExecution((o) => o.reconcile(this.data.signals, this.data.execution));
  }

  // ---- extended TP --------------------------------------------------------
  async previewExtended(signalId: string, price: number): Promise<ExtendedTpPreview> {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) this.fail('Signal not found.');
    const m = await this.market(s.symbol);
    const px = s.direction === 'BUY' ? m.bid : m.ask;
    return previewExtendedTp(s, price, this.data.execution.orders, this.data.execution.positions, this.signalTickSize(s.groupPlans.map((g) => g.groupId), s.symbol), px);
  }

  async activateExtended(signalId: string, price: number) {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) this.fail('Signal not found.');
    const preview = await this.previewExtended(signalId, price);
    if (!preview.validation.ok) this.fail(preview.validation.errors.join(' '));
    const next = activateExtendedTp(s, price, this.nowIso());
    await this.runExecution(
      (o) => o.applyTpChanges(preview.changes, this.data.execution),
      (d) =>
        this.audit({ ...d, signals: d.signals.map((x) => (x.id === signalId ? next : x)) }, 'signal', 'extended_tp_activated', `Extended TP ${price} activated (${preview.changes.length} item(s) affected). SL unchanged.`, signalId, {
          price,
          changes: preview.changes,
        }),
    );
  }

  async resetExtended(signalId: string) {
    const s = this.data.signals.find((x) => x.id === signalId);
    if (!s) this.fail('Signal not found.');
    const next = resetExtendedTp(s, this.nowIso());
    const changes = previewResetTp(next, this.data.execution.orders, this.data.execution.positions, this.signalTickSize(s.groupPlans.map((g) => g.groupId), s.symbol));
    await this.runExecution(
      (o) => o.applyTpChanges(changes, this.data.execution),
      (d) => this.audit({ ...d, signals: d.signals.map((x) => (x.id === signalId ? next : x)) }, 'signal', 'extended_tp_reset', `Extended TP reset to default per-entry TP (${changes.length} item(s)).`, signalId),
    );
  }

  // ---- safety -------------------------------------------------------------
  async emergencyDisable() {
    const d0 = { ...this.data, settings: { ...this.data.settings, emergencyDisabled: true } };
    this.commit(d0);
    await this.runExecution((o) => o.emergencyDisable(this.data.execution));
  }

  clearEmergency() {
    this.commit(this.audit({ ...this.data, settings: { ...this.data.settings, emergencyDisabled: false } }, 'safety', 'emergency_cleared', 'Emergency disable cleared by user.'));
  }

  // ---- simulator ----------------------------------------------------------
  async setSimulatedQuote(symbol: string, bid: number, ask: number, sessionOpen: boolean) {
    if (!(bid > 0) || !(ask >= bid)) this.fail('Ask must be ≥ bid and both positive.');
    this.sim.setMarket(symbol, { bid, ask, sessionOpen });
    this.commit(this.audit(this.data, 'execution', 'sim_quote', `SIMULATED quote ${symbol} ${bid}/${ask} (${sessionOpen ? 'open' : 'closed'}) entered by user.`, undefined, undefined, true));
    if (this.data.settings.provider === 'simulator') await this.reconcile();
  }

  setSimulatorFaults(f: Partial<SimulatorFaults>) {
    this.sim.setFaults(f);
    this.commit(this.audit(this.data, 'execution', 'sim_faults', 'Simulator fault injection changed.', undefined, { ...f }, true));
  }

  // ---- settings & data ----------------------------------------------------
  setProvider(p: ProviderChoice) {
    this.commit(this.audit({ ...this.data, settings: { ...this.data.settings, provider: p } }, 'settings', 'provider_changed', `Execution provider set to ${p === 'simulator' ? 'Simulator' : 'MT5 (unavailable)'}.`));
  }

  setStrategy(strategy: StrategyConfig) {
    if (!(strategy.stopLossDistance > 0) || !(strategy.defaultTpPips > 0) || !(strategy.strategyPipSize > 0)) this.fail('Strategy values must be positive.');
    this.commit(this.audit({ ...this.data, settings: { ...this.data.settings, strategy } }, 'settings', 'strategy_changed', `Strategy defaults updated: TP ${strategy.defaultTpPips}×${strategy.strategyPipSize}, SL ${strategy.stopLossDistance}.`, undefined, { ...strategy }));
  }

  exportJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  importJson(json: string) {
    let parsed: AppData;
    try {
      parsed = JSON.parse(json) as AppData;
    } catch {
      this.fail('File is not valid JSON.');
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.groups)) this.fail('Unrecognised backup format.');
    if (parsed.accounts.length > MAX_ACCOUNTS) this.fail(`Backup contains more than ${MAX_ACCOUNTS} accounts.`);
    const data = { ...emptyData(), ...parsed };
    this.sim = new SimulatedExecutionProvider({ now: () => this.nowIso() });
    if (data.simulator) this.sim.restore(data.simulator);
    this.commit(this.audit(data, 'settings', 'imported', 'Data imported from backup file.'));
  }

  loadDemoData() {
    if (this.data.accounts.length || this.data.groups.length) this.fail('Demo data can only be loaded into an empty workspace.');
    const demo = buildDemoData(newId, this.nowIso());
    this.commit(this.audit({ ...this.data, ...demo }, 'settings', 'demo_loaded', 'Labelled DEMO fixtures loaded (fictional firm, server and illustrative instrument spec).'));
  }

  resetAll() {
    this.sim = new SimulatedExecutionProvider({ now: () => this.nowIso() });
    this.commit(this.audit(emptyData(), 'settings', 'reset', 'All local data erased by user.'));
  }
}
