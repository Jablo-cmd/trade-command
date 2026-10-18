/**
 * Execution orchestrator: submits planned orders through an ExecutionProvider,
 * reconciles provider state into local records, applies TP changes, cancels orders
 * and implements the emergency disable.
 *
 * Invariants:
 *  - One local order per clientOrderId (duplicates are refused and audited).
 *  - Local state only advances on provider-confirmed results.
 *  - TP changes are shown as `requested` until the provider confirms; SL is never
 *    altered by a TP change.
 *  - Non-simulated providers are refused while LIVE_EXECUTION_ENABLED is false.
 */
import { createAuditEvent } from '../domain/audit';
import type { TpChange } from '../domain/extendedTp';
import { canTransition, isWorking, targetLevelsForFills } from '../domain/orders';
import type { PlannedOrder } from '../domain/plan';
import type { AuditEvent, Fill, MasterSignal, Order, OrderState, Position } from '../domain/types';
import type { ExecutionProvider } from './provider';

/**
 * Hard switch. V1 ships with live execution disabled: there is no authorised broker
 * connector, and prop-firm permissions are unverified. Do not flip this in the client;
 * live execution must be implemented server-side.
 */
export const LIVE_EXECUTION_ENABLED = false;

export interface ExecutionState {
  orders: Order[];
  fills: Fill[];
  positions: Position[];
}

export interface OrchestratorDeps {
  provider: ExecutionProvider;
  newId: () => string;
  now: () => string;
  audit: (e: AuditEvent) => void;
  tickSizeFor: (accountId: string, symbol: string) => number;
  /** Human-readable account name for audit messages (keys stay in entityId). */
  accountName?: (accountId: string) => string;
}

export class ExecutionOrchestrator {
  constructor(private readonly d: OrchestratorDeps) {}

  private log(category: AuditEvent['category'], action: string, message: string, entityId?: string, details?: Record<string, unknown>) {
    this.d.audit(
      createAuditEvent(this.d.newId(), this.d.now(), category, action, message, {
        entityId,
        details,
        simulated: this.d.provider.info.simulated,
      }),
    );
  }

  private label(o: Pick<Order, 'accountId' | 'type' | 'limitPrice'>): string {
    const name = this.d.accountName?.(o.accountId) ?? `account …${o.accountId.slice(-6)}`;
    return `${name} ${o.type.replace('_', ' ')} @ ${o.limitPrice}`;
  }

  private guardProvider(): string | undefined {
    if (!this.d.provider.info.simulated && !LIVE_EXECUTION_ENABLED) {
      return 'Live execution is disabled in this build. No broker orders can be sent.';
    }
    return undefined;
  }

  /** Submit `ready` planned orders. Returns the new state. */
  async submit(
    signal: MasterSignal,
    plan: PlannedOrder[],
    state: ExecutionState,
    opts: { emergencyDisabled: boolean },
  ): Promise<ExecutionState> {
    const blocked = this.guardProvider();
    if (blocked) {
      this.log('safety', 'live_blocked', blocked, signal.id);
      throw new Error(blocked);
    }
    if (opts.emergencyDisabled) {
      this.log('safety', 'submit_blocked', 'Submission refused: emergency disable is active.', signal.id);
      throw new Error('Emergency disable is active.');
    }
    let orders = [...state.orders];
    for (const p of plan) {
      if (p.status !== 'ready' || !p.risk || p.risk.volume <= 0) continue;
      if (orders.some((o) => o.clientOrderId === p.clientOrderId)) {
        this.log('order', 'duplicate_prevented', `Duplicate submission prevented for ${p.accountName} (${p.groupName}).`, p.clientOrderId);
        continue;
      }
      const now = this.d.now();
      let order: Order = {
        id: this.d.newId(),
        clientOrderId: p.clientOrderId,
        signalId: signal.id,
        groupId: p.groupId,
        accountId: p.accountId,
        symbol: p.symbol,
        direction: p.direction,
        type: p.orderType,
        volume: p.risk.volume,
        filledVolume: 0,
        limitPrice: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        state: 'pending_submission',
        providerName: this.d.provider.info.name,
        simulated: this.d.provider.info.simulated,
        createdAt: now,
        updatedAt: now,
      };
      orders.push(order);
      this.log('order', 'submit_requested', `Submitting ${p.orderType} ${p.risk.volume} ${p.symbol} @ ${p.entryPrice} for ${p.accountName}.`, order.clientOrderId, {
        volume: p.risk.volume,
        entry: p.entryPrice,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        riskAmount: p.risk.riskAmount,
      });
      try {
        const res = await this.d.provider.submitOrder({
          clientOrderId: p.clientOrderId,
          accountId: p.accountId,
          symbol: p.symbol,
          type: p.orderType,
          volume: p.risk.volume,
          price: p.entryPrice,
          stopLoss: p.stopLoss,
          takeProfit: p.takeProfit,
        });
        if (!res.ok) {
          order = { ...order, state: 'rejected', rejectReason: `${res.code}: ${res.message}`, updatedAt: this.d.now() };
          this.log('order', 'rejected', `Order rejected for ${p.accountName}: ${res.message}`, order.clientOrderId);
        } else {
          order = { ...order, state: 'submitted', providerOrderId: res.value.providerOrderId, updatedAt: this.d.now() };
          order = this.advance(order, res.value.state, res.value.rejectReason);
          this.log('order', 'submitted', `Provider accepted request for ${p.accountName}: ${res.value.state}.`, order.clientOrderId);
        }
      } catch (e) {
        // Outcome unknown (e.g. network failure). Do not resubmit; reconcile instead.
        order = { ...order, state: 'unknown', rejectReason: String(e), updatedAt: this.d.now() };
        this.log('order', 'unknown', `Submission outcome unknown for ${p.accountName}; reconcile before retrying.`, order.clientOrderId);
      }
      orders = orders.map((o) => (o.clientOrderId === order.clientOrderId ? order : o));
    }
    return this.reconcile([signal], { ...state, orders });
  }

  private advance(order: Order, to: OrderState, reason?: string): Order {
    if (order.state === to) return order;
    if (!canTransition(order.state, to)) {
      this.log('order', 'invalid_transition', `Unexpected provider state ${order.state} → ${to}; marked unknown.`, order.clientOrderId);
      return order.state === 'unknown' ? order : { ...order, state: 'unknown', updatedAt: this.d.now() };
    }
    return { ...order, state: to, updatedAt: this.d.now(), ...(reason ? { rejectReason: reason } : {}) };
  }

  /** Pull provider state and update orders, fills and positions; re-base SL/TP on actual fills. */
  async reconcile(signals: MasterSignal[], state: ExecutionState): Promise<ExecutionState> {
    const [po, pf, pp] = await Promise.all([this.d.provider.listOrders(), this.d.provider.listFills(), this.d.provider.listPositions()]);
    if (!po.ok || !pf.ok || !pp.ok) {
      this.log('execution', 'reconcile_failed', 'Reconciliation failed: provider data unavailable.');
      return state;
    }
    const orders = state.orders.map((o) => {
      const remote = po.value.find((r) => r.clientOrderId === o.clientOrderId);
      if (!remote) return o;
      const next = this.advance({ ...o, filledVolume: remote.filledVolume, providerOrderId: remote.providerOrderId }, remote.state, remote.rejectReason);
      if (next.state !== o.state) this.log('order', 'state_changed', `${this.label(o)}: ${o.state} → ${next.state}.`, o.clientOrderId);
      return { ...next, stopLoss: remote.stopLoss, takeProfit: remote.takeProfit };
    });

    const fills = [...state.fills];
    for (const f of pf.value) {
      if (fills.some((x) => x.id === f.fillId)) continue;
      const o = orders.find((x) => x.clientOrderId === f.clientOrderId);
      if (!o) continue;
      fills.push({ id: f.fillId, orderId: o.id, accountId: f.accountId, price: f.price, volume: f.volume, at: f.at, simulated: this.d.provider.info.simulated });
      this.log('order', 'fill', `Fill ${f.volume} @ ${f.price} on ${this.label(o)}.`, o.clientOrderId, { price: f.price, volume: f.volume });
    }

    let positions = [...state.positions];
    for (const rp of pp.value) {
      const o = orders.find((x) => x.clientOrderId === rp.clientOrderId);
      if (!o) continue;
      const signal = signals.find((s) => s.id === o.signalId);
      const existing = positions.find((p) => p.orderId === o.id);
      const base: Position = existing ?? {
        id: this.d.newId(),
        orderId: o.id,
        signalId: o.signalId,
        accountId: o.accountId,
        groupId: o.groupId,
        symbol: o.symbol,
        direction: o.direction,
        volume: rp.volume,
        entryPrice: rp.entryPrice,
        stopLoss: rp.stopLoss,
        takeProfit: rp.takeProfit,
        tpModification: { state: 'none' },
        status: 'open',
        simulated: this.d.provider.info.simulated,
        openedAt: this.d.now(),
      };
      let pos: Position = {
        ...base,
        volume: rp.volume,
        entryPrice: rp.entryPrice,
        stopLoss: rp.stopLoss,
        takeProfit: rp.takeProfit,
        status: rp.status,
        closePrice: rp.closePrice,
        closedAt: rp.closedAt,
      };
      if (!existing) this.log('order', 'position_opened', `Position opened ${o.symbol} ${rp.volume} @ ${rp.entryPrice}.`, o.clientOrderId);
      if (existing && existing.status === 'open' && rp.status === 'closed') {
        this.log('order', 'position_closed', `Position closed @ ${rp.closePrice}.`, o.clientOrderId);
      }
      // Re-base protective levels on ACTUAL fills.
      if (signal && pos.status === 'open') {
        const myFills = fills.filter((f) => f.orderId === o.id);
        if (myFills.length) {
          const target = targetLevelsForFills(signal, myFills, this.d.tickSizeFor(o.accountId, o.symbol));
          const alreadyFailed = pos.tpModification.state === 'failed' && pos.tpModification.requested === target.takeProfit;
          if (!alreadyFailed && (target.stopLoss !== pos.stopLoss || target.takeProfit !== pos.takeProfit)) {
            pos = await this.modifyPosition(pos, o, target.stopLoss, target.takeProfit, 'Re-based on actual fill price');
          }
        }
      }
      positions = existing ? positions.map((p) => (p.id === pos.id ? pos : p)) : [...positions, pos];
    }
    return { orders, fills, positions };
  }

  private async modifyPosition(pos: Position, o: Order, stopLoss: number, takeProfit: number, why: string): Promise<Position> {
    const at = this.d.now();
    const requested: Position = { ...pos, tpModification: { state: 'requested', requested: takeProfit, at } };
    this.log('order', 'modify_requested', `${why}: SL ${stopLoss}, TP ${takeProfit} on ${this.label(o)}.`, o.clientOrderId);
    const res = await this.d.provider.modifyProtection({ clientOrderId: o.clientOrderId, target: 'position', stopLoss, takeProfit });
    if (!res.ok) {
      this.log('order', 'modify_failed', `Modification failed on ${this.label(o)}: ${res.message}`, o.clientOrderId);
      return { ...requested, tpModification: { state: 'failed', requested: takeProfit, reason: res.message, at } };
    }
    this.log('order', 'modify_confirmed', `Provider confirmed SL ${res.value.stopLoss}, TP ${res.value.takeProfit} on ${this.label(o)}.`, o.clientOrderId);
    return { ...requested, stopLoss: res.value.stopLoss, takeProfit: res.value.takeProfit, tpModification: { state: 'confirmed', requested: takeProfit, at } };
  }

  /** Apply TP changes (extended activation or reset). SL is passed through unchanged. */
  async applyTpChanges(changes: TpChange[], state: ExecutionState): Promise<ExecutionState> {
    const blocked = this.guardProvider();
    if (blocked) throw new Error(blocked);
    let { orders, positions } = state;
    for (const c of changes) {
      if (c.kind === 'position') {
        const pos = positions.find((p) => p.id === c.id);
        const o = pos && orders.find((x) => x.id === pos.orderId);
        if (!pos || !o) continue;
        const updated = await this.modifyPosition(pos, o, pos.stopLoss, c.newTp, 'TP change');
        positions = positions.map((p) => (p.id === pos.id ? updated : p));
      } else {
        const o = orders.find((x) => x.id === c.id);
        if (!o) continue;
        this.log('order', 'modify_requested', `TP change on pending ${this.label(o)}: ${o.takeProfit} → ${c.newTp}.`, o.clientOrderId);
        const res = await this.d.provider.modifyProtection({ clientOrderId: o.clientOrderId, target: 'order', stopLoss: o.stopLoss, takeProfit: c.newTp });
        if (!res.ok) {
          this.log('order', 'modify_failed', `Pending-order TP change failed on ${this.label(o)}: ${res.message}`, o.clientOrderId);
        } else {
          this.log('order', 'modify_confirmed', `Provider confirmed TP ${res.value.takeProfit} on pending ${this.label(o)}.`, o.clientOrderId);
          orders = orders.map((x) => (x.id === o.id ? { ...x, takeProfit: res.value.takeProfit, updatedAt: this.d.now() } : x));
        }
      }
    }
    return { ...state, orders, positions };
  }

  async cancel(clientOrderId: string, state: ExecutionState, reason: string): Promise<ExecutionState> {
    const o = state.orders.find((x) => x.clientOrderId === clientOrderId);
    if (!o || !isWorking(o.state)) return state;
    let orders = state.orders.map((x) => (x.id === o.id && canTransition(x.state, 'cancel_requested') ? { ...x, state: 'cancel_requested' as const, updatedAt: this.d.now() } : x));
    this.log('order', 'cancel_requested', `Cancel requested for ${this.label(o)} (${reason}).`, clientOrderId);
    const res = await this.d.provider.cancelOrder(clientOrderId);
    if (!res.ok) {
      this.log('order', 'cancel_failed', `Cancel failed for ${this.label(o)}: ${res.message}`, clientOrderId);
      // Revert optimistic state and let reconciliation show the provider's view.
      orders = orders.map((x) => (x.id === o.id ? { ...x, state: o.state } : x));
      return { ...state, orders };
    }
    orders = orders.map((x) => (x.id === o.id ? this.advance(x, res.value.state) : x));
    this.log('order', 'cancelled', `Provider confirmed ${res.value.state} for ${this.label(o)}.`, clientOrderId);
    return { ...state, orders };
  }

  async cancelAllForSignal(signalId: string, state: ExecutionState, reason: string): Promise<ExecutionState> {
    let s = state;
    for (const o of state.orders.filter((x) => x.signalId === signalId && isWorking(x.state))) s = await this.cancel(o.clientOrderId, s, reason);
    return s;
  }

  /** Emergency disable: cancels every working order. Open positions keep their SL/TP. */
  async emergencyDisable(state: ExecutionState): Promise<ExecutionState> {
    this.log('safety', 'emergency_disable', 'EMERGENCY DISABLE activated: cancelling all working orders and blocking new submissions.');
    let s = state;
    for (const o of state.orders.filter((x) => isWorking(x.state))) s = await this.cancel(o.clientOrderId, s, 'emergency disable');
    return s;
  }
}
