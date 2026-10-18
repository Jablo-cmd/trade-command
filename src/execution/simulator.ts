/**
 * SIMULATED execution provider for development and tests.
 *
 * - Prices are set explicitly by the user/test (no fake "live" feed).
 * - A limit fills only when price trades THROUGH it by at least one tick; a touch
 *   alone does not fill (configurable).
 * - Supports injected rejections, partial fills and failed modifications so that the
 *   orchestrator's failure paths can be exercised.
 * - Every object it produces is flagged as simulated.
 */
import { normalize } from '../domain/price';
import type { MarketContext } from '../domain/staging';
import type { OrderState } from '../domain/types';
import type {
  ExecutionProvider,
  ModifyProtectionRequest,
  ProviderAccountInfo,
  ProviderFill,
  ProviderOrder,
  ProviderPosition,
  ProviderResult,
  SubmitOrderRequest,
} from './provider';

export interface SimulatorFaults {
  /** Accounts whose next submissions are rejected. */
  rejectAccounts: string[];
  /** Accounts whose SL/TP modifications fail. */
  failModifyAccounts: string[];
  /** If set (0–1), the first fill of each limit order is this fraction of its volume. */
  partialFillRatio?: number;
  /** Model a price gap: limits crossed by the quote fill at the (better) quote instead of the limit. */
  gapFillsAtMarket?: boolean;
}

export interface SimulatorSnapshot {
  market: Record<string, MarketContext>;
  orders: ProviderOrder[];
  fills: ProviderFill[];
  positions: ProviderPosition[];
  faults: SimulatorFaults;
  seq: number;
  fillOnTouch: boolean;
}

export interface SimulatorOptions {
  tickSize?: number;
  volumeStep?: number;
  now?: () => string;
  fillOnTouch?: boolean;
}

const WORKING: OrderState[] = ['acknowledged', 'partially_filled'];

export class SimulatedExecutionProvider implements ExecutionProvider {
  readonly info = { name: 'Simulator (no broker — not real executions)', kind: 'simulator' as const, simulated: true };
  readonly capabilities = { pendingOrders: true, marketOrders: true, modifyProtection: true, cancelOrders: true, reconcile: true };

  private market: Record<string, MarketContext> = {};
  private orders = new Map<string, ProviderOrder>();
  private fills: ProviderFill[] = [];
  private positions = new Map<string, ProviderPosition>();
  private faults: SimulatorFaults = { rejectAccounts: [], failModifyAccounts: [] };
  private seq = 0;
  private readonly tick: number;
  private readonly step: number;
  private readonly now: () => string;
  private fillOnTouch: boolean;

  constructor(opts: SimulatorOptions = {}) {
    this.tick = opts.tickSize ?? 0.01;
    this.step = opts.volumeStep ?? 0.01;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.fillOnTouch = opts.fillOnTouch ?? false;
  }

  // ---- simulator controls -------------------------------------------------

  setFaults(f: Partial<SimulatorFaults>) {
    this.faults = { ...this.faults, ...f };
  }
  getFaults(): SimulatorFaults {
    return { ...this.faults };
  }

  /** Set a simulated quote and process limit orders and SL/TP against it. */
  setMarket(symbol: string, m: MarketContext) {
    this.market[symbol.toUpperCase()] = { ...m };
    this.process(symbol.toUpperCase());
  }

  snapshot(): SimulatorSnapshot {
    return {
      market: structuredClone(this.market),
      orders: [...this.orders.values()].map((o) => ({ ...o })),
      fills: this.fills.map((f) => ({ ...f })),
      positions: [...this.positions.values()].map((p) => ({ ...p })),
      faults: structuredClone(this.faults),
      seq: this.seq,
      fillOnTouch: this.fillOnTouch,
    };
  }

  restore(s: SimulatorSnapshot) {
    this.market = structuredClone(s.market);
    this.orders = new Map(s.orders.map((o) => [o.clientOrderId, { ...o }]));
    this.fills = s.fills.map((f) => ({ ...f }));
    this.positions = new Map(s.positions.map((p) => [p.clientOrderId, { ...p }]));
    this.faults = structuredClone(s.faults);
    this.seq = s.seq;
    this.fillOnTouch = s.fillOnTouch;
  }

  // ---- ExecutionProvider --------------------------------------------------

  connectionState() {
    return Promise.resolve('connected' as const);
  }

  getMarket(symbol: string): Promise<ProviderResult<MarketContext>> {
    const m = this.market[symbol.toUpperCase()];
    return Promise.resolve(m ? { ok: true, value: { ...m } } : { ok: false, code: 'not_found', message: 'No simulated price set.' });
  }

  getAccountInfo(): Promise<ProviderResult<ProviderAccountInfo>> {
    return Promise.resolve({ ok: false, code: 'unsupported', message: 'Simulator does not invent balances; enter a manual snapshot.' });
  }

  listOrders() {
    return Promise.resolve({ ok: true as const, value: [...this.orders.values()].map((o) => ({ ...o })) });
  }
  listFills() {
    return Promise.resolve({ ok: true as const, value: this.fills.map((f) => ({ ...f })) });
  }
  listPositions() {
    return Promise.resolve({ ok: true as const, value: [...this.positions.values()].map((p) => ({ ...p })) });
  }

  submitOrder(req: SubmitOrderRequest): Promise<ProviderResult<ProviderOrder>> {
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return Promise.resolve({ ok: true, value: { ...existing } }); // idempotent

    const id = `SIM-${++this.seq}`;
    const base: ProviderOrder = {
      providerOrderId: id,
      clientOrderId: req.clientOrderId,
      accountId: req.accountId,
      symbol: req.symbol.toUpperCase(),
      type: req.type,
      volume: req.volume,
      filledVolume: 0,
      price: req.price,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      state: 'acknowledged',
    };
    const reject = (reason: string) => {
      const o = { ...base, state: 'rejected' as const, rejectReason: reason };
      this.orders.set(req.clientOrderId, o);
      return Promise.resolve({ ok: true as const, value: { ...o } });
    };
    if (this.faults.rejectAccounts.includes(req.accountId)) return reject('Simulated broker rejection (fault injection).');
    const m = this.market[base.symbol];
    if (!m || m.bid === undefined || m.ask === undefined) return reject('No simulated price available.');
    if (m.sessionOpen === false) return reject('Market closed (simulated).');

    if (req.type === 'BUY_MARKET' || req.type === 'SELL_MARKET') {
      const px = req.type === 'BUY_MARKET' ? m.ask : m.bid;
      this.orders.set(req.clientOrderId, base);
      this.fill(base, px, req.volume);
      return Promise.resolve({ ok: true, value: { ...this.orders.get(req.clientOrderId)! } });
    }
    if (req.type === 'BUY_LIMIT' && req.price >= m.ask) return reject('BUY LIMIT must be below the current ask.');
    if (req.type === 'SELL_LIMIT' && req.price <= m.bid) return reject('SELL LIMIT must be above the current bid.');
    this.orders.set(req.clientOrderId, base);
    return Promise.resolve({ ok: true, value: { ...base } });
  }

  modifyProtection(req: ModifyProtectionRequest): Promise<ProviderResult<{ stopLoss: number; takeProfit: number }>> {
    const accountId = req.target === 'order' ? this.orders.get(req.clientOrderId)?.accountId : this.positions.get(req.clientOrderId)?.accountId;
    if (!accountId) return Promise.resolve({ ok: false, code: 'not_found', message: 'Unknown order/position.' });
    if (this.faults.failModifyAccounts.includes(accountId)) {
      return Promise.resolve({ ok: false, code: 'rejected', message: 'Simulated modification failure (fault injection).' });
    }
    if (req.target === 'order') {
      const o = this.orders.get(req.clientOrderId)!;
      if (!WORKING.includes(o.state)) return Promise.resolve({ ok: false, code: 'invalid_state', message: `Order is ${o.state}.` });
      this.orders.set(o.clientOrderId, { ...o, stopLoss: req.stopLoss, takeProfit: req.takeProfit });
    } else {
      const p = this.positions.get(req.clientOrderId)!;
      if (p.status !== 'open') return Promise.resolve({ ok: false, code: 'invalid_state', message: 'Position is closed.' });
      const m = this.market[p.symbol];
      const isBuy = this.orders.get(p.clientOrderId)?.type.startsWith('BUY') ?? true;
      if (m?.bid !== undefined && m.ask !== undefined) {
        if (isBuy && req.takeProfit <= m.bid) return Promise.resolve({ ok: false, code: 'rejected', message: 'TP is at or below current bid.' });
        if (!isBuy && req.takeProfit >= m.ask) return Promise.resolve({ ok: false, code: 'rejected', message: 'TP is at or above current ask.' });
      }
      this.positions.set(p.clientOrderId, { ...p, stopLoss: req.stopLoss, takeProfit: req.takeProfit });
    }
    return Promise.resolve({ ok: true, value: { stopLoss: req.stopLoss, takeProfit: req.takeProfit } });
  }

  cancelOrder(clientOrderId: string): Promise<ProviderResult<ProviderOrder>> {
    const o = this.orders.get(clientOrderId);
    if (!o) return Promise.resolve({ ok: false, code: 'not_found', message: 'Unknown order.' });
    if (!WORKING.includes(o.state)) return Promise.resolve({ ok: false, code: 'invalid_state', message: `Order is ${o.state}; cannot cancel.` });
    const c = { ...o, state: 'cancelled' as const };
    this.orders.set(clientOrderId, c);
    return Promise.resolve({ ok: true, value: { ...c } });
  }

  // ---- internals ----------------------------------------------------------

  private fill(o: ProviderOrder, price: number, volume: number) {
    const filledVolume = normalize(o.filledVolume + volume, this.step);
    const state: OrderState = filledVolume + this.step / 1000 >= o.volume ? 'filled' : 'partially_filled';
    const updated = { ...o, filledVolume, state };
    this.orders.set(o.clientOrderId, updated);
    this.fills.push({ fillId: `SIMF-${++this.seq}`, clientOrderId: o.clientOrderId, accountId: o.accountId, price, volume, at: this.now() });
    const prev = this.positions.get(o.clientOrderId);
    const vol = normalize((prev?.volume ?? 0) + volume, this.step);
    const entry = prev ? normalize((prev.entryPrice * prev.volume + price * volume) / vol, this.tick) : price;
    this.positions.set(o.clientOrderId, {
      clientOrderId: o.clientOrderId,
      accountId: o.accountId,
      symbol: o.symbol,
      volume: vol,
      entryPrice: entry,
      stopLoss: prev?.stopLoss ?? o.stopLoss,
      takeProfit: prev?.takeProfit ?? o.takeProfit,
      status: 'open',
    });
  }

  private process(symbol: string) {
    const m = this.market[symbol];
    if (!m || m.bid === undefined || m.ask === undefined || m.sessionOpen === false) return;
    const through = this.fillOnTouch ? 0 : this.tick;
    for (const o of [...this.orders.values()]) {
      if (o.symbol !== symbol || !WORKING.includes(o.state)) continue;
      const remaining = normalize(o.volume - o.filledVolume, this.step);
      const touched = o.type === 'BUY_LIMIT' ? m.ask <= o.price - through + 1e-9 : o.type === 'SELL_LIMIT' ? m.bid >= o.price + through - 1e-9 : false;
      if (!touched) continue;
      // Resting limits fill at the limit price; a modelled gap fills at the better quote.
      const px = !this.faults.gapFillsAtMarket ? o.price : o.type === 'BUY_LIMIT' ? Math.min(m.ask, o.price) : Math.max(m.bid, o.price);
      const ratio = this.faults.partialFillRatio;
      const vol =
        o.filledVolume === 0 && ratio && ratio > 0 && ratio < 1 ? Math.max(this.step, normalize(Math.floor((o.volume * ratio) / this.step) * this.step, this.step)) : remaining;
      this.fill(o, px, Math.min(vol, remaining));
    }
    for (const p of [...this.positions.values()]) {
      if (p.symbol !== symbol || p.status !== 'open') continue;
      const isBuy = this.orders.get(p.clientOrderId)?.type.startsWith('BUY') ?? true;
      const hitTp = isBuy ? m.bid >= p.takeProfit : m.ask <= p.takeProfit;
      const hitSl = isBuy ? m.bid <= p.stopLoss : m.ask >= p.stopLoss;
      if (hitSl || hitTp) {
        this.positions.set(p.clientOrderId, { ...p, status: 'closed', closePrice: hitSl ? p.stopLoss : p.takeProfit, closedAt: this.now() });
      }
    }
  }
}
