/**
 * Execution provider backed by the MT5 connector on a Windows VPS.
 *
 * The app never talks to MT5. It queues commands in Supabase (`execution_commands`); the
 * connector claims each one, re-validates it against live MT5 data and the account's risk
 * limits, acts, and records results in orders/fills/positions. This provider waits for the
 * connector's verdict and reports exactly what the connector confirmed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MarketContext } from '../domain/staging';
import type { OrderState, OrderType } from '../domain/types';
import type {
  ExecutionProvider,
  ModifyProtectionRequest,
  ProviderAccountInfo,
  ProviderAccountState,
  ProviderFill,
  ProviderOrder,
  ProviderPosition,
  ProviderResult,
  SubmitOrderRequest,
} from './provider';

type Row = Record<string, unknown>;
type DbResult<T> = { data: T | null; error: { code?: string; message: string } | null };

/** The few Supabase queries this provider needs (an adapter keeps it testable). */
export interface ConnectorDb {
  insertCommand(row: Row): Promise<DbResult<Row>>;
  getCommand(id: string): Promise<DbResult<Row>>;
  findSubmit(clientOrderId: string): Promise<DbResult<Row>>;
  list(table: 'orders' | 'fills' | 'positions' | 'connector_heartbeats'): Promise<DbResult<Row[]>>;
  /** Server-side kill switch the connector checks before every order (profiles.emergency_disabled). */
  setEmergency(on: boolean): Promise<DbResult<unknown>>;
}

export function supabaseConnectorDb(sb: SupabaseClient): ConnectorDb {
  return {
    insertCommand: async (row) => (await sb.from('execution_commands').insert(row).select().single()) as DbResult<Row>,
    getCommand: async (id) => (await sb.from('execution_commands').select('*').eq('id', id).single()) as DbResult<Row>,
    findSubmit: async (cid) =>
      (await sb.from('execution_commands').select('*').eq('kind', 'submit').eq('client_order_id', cid).maybeSingle()) as DbResult<Row>,
    list: async (table) => (await sb.from(table).select('*')) as DbResult<Row[]>,
    setEmergency: async (on) => {
      const { data } = await sb.auth.getUser();
      if (!data.user) return { data: null, error: { message: 'Not signed in.' } };
      return (await sb.from('profiles').upsert({ id: data.user.id, emergency_disabled: on })) as DbResult<unknown>;
    },
  };
}

export interface ConnectorOptions {
  /** How long to wait for the connector's verdict before reporting "unknown". */
  timeoutMs?: number;
  pollMs?: number;
  /** A heartbeat older than this means the connector is not running. */
  staleAfterMs?: number;
  /** A quote older than this is not used for previews. */
  quoteMaxAgeMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));

export class ConnectorProvider implements ExecutionProvider {
  readonly info = {
    name: 'MT5 connector (Windows VPS)',
    kind: 'mt5' as const,
    simulated: false,
    serverValidated: true,
    managesProtection: true,
  };
  readonly capabilities = { pendingOrders: true, marketOrders: true, modifyProtection: true, cancelOrders: true, reconcile: true };
  private readonly o: Required<ConnectorOptions>;

  constructor(
    private readonly db: ConnectorDb,
    opts: ConnectorOptions = {},
  ) {
    this.o = {
      timeoutMs: opts.timeoutMs ?? 30_000,
      pollMs: opts.pollMs ?? 1_000,
      staleAfterMs: opts.staleAfterMs ?? 30_000,
      quoteMaxAgeMs: opts.quoteMaxAgeMs ?? 60_000,
      now: opts.now ?? (() => Date.now()),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  // ---- connector state ------------------------------------------------------
  private async heartbeats(): Promise<Row[]> {
    const r = await this.db.list('connector_heartbeats');
    return r.data ?? [];
  }

  private fresh(iso: unknown, maxAge: number): boolean {
    return typeof iso === 'string' && this.o.now() - Date.parse(iso) <= maxAge;
  }

  private stateOf(hb: Row | undefined): ProviderAccountState {
    if (!hb) return { connection: 'disconnected', tradeMode: 'unknown', error: 'No connector has reported for this account.' };
    const alive = this.fresh(hb.last_seen, this.o.staleAfterMs);
    const connection = !alive ? 'disconnected' : !hb.terminal_connected ? 'disconnected' : !hb.login_verified ? 'unauthorized' : 'connected';
    return {
      connection,
      tradeMode: (hb.trade_mode as ProviderAccountState['tradeMode']) ?? 'unknown',
      balance: n(hb.balance),
      equity: n(hb.equity),
      dailyLossUsed: n(hb.daily_loss_used),
      currency: hb.currency as string | undefined,
      server: hb.server as string | undefined,
      lastSeen: hb.last_seen as string | undefined,
      error: !alive ? 'Connector heartbeat is stale; the VPS program may be stopped.' : ((hb.error as string | null) ?? undefined),
    };
  }

  async accountStates(): Promise<Record<string, ProviderAccountState>> {
    const out: Record<string, ProviderAccountState> = {};
    for (const hb of await this.heartbeats()) out[String(hb.account_id)] = this.stateOf(hb);
    return out;
  }

  async connectionState(accountId: string) {
    const hb = (await this.heartbeats()).find((h) => h.account_id === accountId);
    return this.stateOf(hb).connection;
  }

  async getMarket(symbol: string): Promise<ProviderResult<MarketContext>> {
    let best: { bid: number; ask: number; time: string } | undefined;
    for (const hb of await this.heartbeats()) {
      if (!this.fresh(hb.last_seen, this.o.staleAfterMs) || !hb.login_verified) continue;
      const q = (hb.quotes as Record<string, { bid: number; ask: number; time: string }> | null)?.[symbol];
      if (q && this.fresh(q.time, this.o.quoteMaxAgeMs) && (!best || q.time > best.time)) best = q;
    }
    if (!best) return { ok: false, code: 'disconnected', message: `No fresh ${symbol} quote from a running connector.` };
    // A fresh broker tick implies the market is trading; the connector re-checks per account.
    return { ok: true, value: { bid: best.bid, ask: best.ask, sessionOpen: true } };
  }

  async getAccountInfo(accountId: string): Promise<ProviderResult<ProviderAccountInfo>> {
    const s = this.stateOf((await this.heartbeats()).find((h) => h.account_id === accountId));
    if (s.connection !== 'connected' || s.balance === undefined || s.equity === undefined) {
      return { ok: false, code: s.connection === 'connected' ? 'unknown' : s.connection, message: s.error ?? 'Account not connected.' };
    }
    return { ok: true, value: { balance: s.balance, equity: s.equity, currency: s.currency ?? '', asOf: s.lastSeen ?? '' } };
  }

  // ---- reading results ------------------------------------------------------
  private toOrder(r: Row): ProviderOrder {
    return {
      providerOrderId: String(r.provider_order_id ?? r.id),
      clientOrderId: String(r.client_order_id),
      accountId: String(r.account_id),
      symbol: String(r.symbol),
      type: r.order_type as OrderType,
      volume: Number(r.volume),
      filledVolume: Number(r.filled_volume),
      price: Number(r.limit_price),
      stopLoss: Number(r.stop_loss),
      takeProfit: Number(r.take_profit),
      state: r.state as OrderState,
      rejectReason: (r.reject_reason as string | null) ?? undefined,
      signalId: String(r.signal_id),
      groupId: (r.group_id as string | null) ?? undefined,
      direction: r.direction as 'BUY' | 'SELL',
    };
  }

  async listOrders(): Promise<ProviderResult<ProviderOrder[]>> {
    const r = await this.db.list('orders');
    if (r.error) return { ok: false, code: 'unknown', message: r.error.message };
    return { ok: true, value: (r.data ?? []).map((x) => this.toOrder(x)) };
  }

  private async clientIds(): Promise<Map<string, string> | undefined> {
    const r = await this.db.list('orders');
    return r.error ? undefined : new Map((r.data ?? []).map((o) => [String(o.id), String(o.client_order_id)]));
  }

  async listFills(): Promise<ProviderResult<ProviderFill[]>> {
    const [ids, r] = await Promise.all([this.clientIds(), this.db.list('fills')]);
    if (!ids || r.error) return { ok: false, code: 'unknown', message: r.error?.message ?? 'orders unavailable' };
    return {
      ok: true,
      value: (r.data ?? [])
        .filter((f) => ids.has(String(f.order_id)))
        .map((f) => ({
          fillId: String(f.provider_fill_id),
          clientOrderId: ids.get(String(f.order_id))!,
          accountId: '',
          price: Number(f.price),
          volume: Number(f.volume),
          at: String(f.filled_at),
        })),
    };
  }

  async listPositions(): Promise<ProviderResult<ProviderPosition[]>> {
    const [ids, r] = await Promise.all([this.clientIds(), this.db.list('positions')]);
    if (!ids || r.error) return { ok: false, code: 'unknown', message: r.error?.message ?? 'orders unavailable' };
    return {
      ok: true,
      value: (r.data ?? [])
        .filter((p) => ids.has(String(p.order_id)))
        .map((p) => ({
          clientOrderId: ids.get(String(p.order_id))!,
          accountId: String(p.account_id),
          symbol: String(p.symbol),
          volume: Number(p.volume),
          entryPrice: Number(p.entry_price),
          stopLoss: Number(p.stop_loss),
          takeProfit: Number(p.take_profit),
          status: p.status as 'open' | 'closed',
          closePrice: n(p.close_price),
          closedAt: (p.closed_at as string | null) ?? undefined,
          tpModification: {
            state: (p.tp_modification_state as 'none' | 'requested' | 'confirmed' | 'failed') ?? 'none',
            requested: n(p.tp_modification_requested),
            reason: (p.tp_modification_reason as string | null) ?? undefined,
          },
        })),
    };
  }

  // ---- commands -------------------------------------------------------------
  /** Wait for the connector to finish a command. Resolves the final row or undefined on timeout. */
  private async awaitCommand(id: string): Promise<Row | undefined> {
    // Bounded by attempts, not wall-clock, so a stuck or skewed clock can never loop forever.
    const attempts = Math.max(1, Math.ceil(this.o.timeoutMs / this.o.pollMs));
    for (let i = 0; i < attempts; i++) {
      const r = await this.db.getCommand(id);
      const status = r.data?.status;
      if (status === 'done' || status === 'rejected' || status === 'failed') return r.data!;
      await this.o.sleep(this.o.pollMs);
    }
    return undefined;
  }

  private reasons(row: Row): string {
    const res = (row.result ?? {}) as { reasons?: string[]; error?: string };
    return res.reasons?.join(' ') ?? res.error ?? 'No reason given.';
  }

  async submitOrder(req: SubmitOrderRequest): Promise<ProviderResult<ProviderOrder>> {
    const [signalId, groupId] = [req.signalId, req.groupId];
    if (!signalId) return { ok: false, code: 'rejected', message: 'Connector orders must belong to a signal.' };
    const kind = req.type.endsWith('_MARKET') ? 'market' : 'limit';
    const direction = req.type.startsWith('BUY') ? 'BUY' : 'SELL';
    let ins = await this.db.insertCommand({
      kind: 'submit',
      account_id: req.accountId,
      signal_id: signalId,
      client_order_id: req.clientOrderId,
      payload: {
        group_id: groupId,
        symbol: req.symbol,
        direction,
        order_kind: kind,
        entry: req.price,
        stop_loss: req.stopLoss,
        take_profit: req.takeProfit,
        volume: req.volume,
      },
    });
    if (ins.error?.code === '23505') ins = await this.db.findSubmit(req.clientOrderId); // already queued: idempotent
    if (ins.error || !ins.data) return { ok: false, code: 'rejected', message: `Could not queue the order: ${ins.error?.message ?? 'unknown error'}` };

    const done = await this.awaitCommand(String(ins.data.id));
    if (!done) return { ok: false, code: 'unknown', message: 'The connector did not answer in time. The order may still be placed; check Positions & orders.' };
    if (done.status === 'rejected') return { ok: false, code: 'rejected', message: this.reasons(done) };
    if (done.status === 'failed') return { ok: false, code: 'unknown', message: `Connector error: ${this.reasons(done)}` };
    const orders = await this.listOrders();
    const found = orders.ok ? orders.value.find((o) => o.clientOrderId === req.clientOrderId) : undefined;
    if (!found) return { ok: false, code: 'unknown', message: 'Connector accepted the order but it is not visible yet.' };
    return { ok: true, value: found };
  }

  async modifyProtection(req: ModifyProtectionRequest): Promise<ProviderResult<{ stopLoss: number; takeProfit: number }>> {
    const orders = await this.listOrders();
    const accountId = orders.ok ? orders.value.find((o) => o.clientOrderId === req.clientOrderId)?.accountId : undefined;
    if (!accountId) return { ok: false, code: 'not_found', message: 'Order not found.' };
    const ins = await this.db.insertCommand({ kind: 'modify_tp', account_id: accountId, client_order_id: req.clientOrderId, payload: { take_profit: req.takeProfit } });
    if (ins.error || !ins.data) return { ok: false, code: 'rejected', message: ins.error?.message ?? 'Could not queue the TP change.' };
    const done = await this.awaitCommand(String(ins.data.id));
    if (!done) return { ok: false, code: 'unknown', message: 'The connector did not answer in time; the TP may or may not have changed.' };
    if (done.status !== 'done') return { ok: false, code: 'rejected', message: this.reasons(done) };
    const res = done.result as { stop_loss: number; take_profit: number };
    return { ok: true, value: { stopLoss: Number(res.stop_loss), takeProfit: Number(res.take_profit) } };
  }

  async cancelOrder(clientOrderId: string): Promise<ProviderResult<ProviderOrder>> {
    const orders = await this.listOrders();
    const o = orders.ok ? orders.value.find((x) => x.clientOrderId === clientOrderId) : undefined;
    if (!o) return { ok: false, code: 'not_found', message: 'Order not found.' };
    const ins = await this.db.insertCommand({ kind: 'cancel', account_id: o.accountId, client_order_id: clientOrderId });
    if (ins.error || !ins.data) return { ok: false, code: 'rejected', message: ins.error?.message ?? 'Could not queue the cancel.' };
    const done = await this.awaitCommand(String(ins.data.id));
    if (!done) return { ok: false, code: 'unknown', message: 'The connector did not answer in time; the order may still be working.' };
    if (done.status !== 'done') return { ok: false, code: 'rejected', message: this.reasons(done) };
    return { ok: true, value: { ...o, state: 'cancelled' } };
  }

  async emergencyDisable(accountIds: string[]): Promise<ProviderResult<{ cancelled: number }>> {
    // Flip the server-side switch first: the connector refuses new orders even if it is offline now.
    const flag = await this.db.setEmergency(true);
    const queued = await Promise.all(accountIds.map((id) => this.db.insertCommand({ kind: 'emergency_disable', account_id: id })));
    const failures = queued.filter((q) => q.error || !q.data);
    let cancelled = 0;
    const unanswered: string[] = [];
    for (const q of queued) {
      if (!q.data) continue;
      const done = await this.awaitCommand(String(q.data.id));
      if (done?.status === 'done') cancelled += Number((done.result as { cancelled?: number })?.cancelled ?? 0);
      else unanswered.push(String(q.data.account_id));
    }
    if (flag.error || failures.length || unanswered.length) {
      return { ok: false, code: 'unknown', message: `${flag.error ? 'The server kill switch could not be set. ' : ''}${failures.length} account(s) could not be queued and ${unanswered.length} did not confirm. Cancel those orders in MT5 directly.` };
    }
    return { ok: true, value: { cancelled } };
  }

  async clearEmergency(): Promise<ProviderResult<void>> {
    const r = await this.db.setEmergency(false);
    return r.error ? { ok: false, code: 'unknown', message: r.error.message } : { ok: true, value: undefined };
  }
}
