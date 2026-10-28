/**
 * Order lifecycle state machine, fills, positions and exposure.
 *
 * A pending order is not a fill; a price touching a limit is not a fill. Only fills
 * reported by the execution provider change filled volume and create positions.
 */
import { normalize } from './price';
import { lossAtStop, profitAt, type ExposureSummary, fxFactor } from './risk';
import { computeStopLoss, resolveTakeProfit } from './strategy';
import type { Fill, InstrumentSpec, MasterSignal, Order, OrderState, Position, TradingAccount } from './types';

export const ORDER_STATE_LABELS: Record<OrderState, string> = {
  planned: 'Planned',
  pending_submission: 'Pending submission',
  submitted: 'Submitted',
  acknowledged: 'Acknowledged (working)',
  partially_filled: 'Partially filled',
  filled: 'Filled',
  rejected: 'Rejected',
  cancel_requested: 'Cancel requested',
  cancelled: 'Cancelled',
  expired: 'Expired',
  unknown: 'Unknown — reconcile',
};

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  planned: ['pending_submission', 'cancelled'],
  pending_submission: ['submitted', 'rejected', 'unknown'],
  submitted: ['acknowledged', 'rejected', 'partially_filled', 'filled', 'unknown', 'cancel_requested', 'expired'],
  acknowledged: ['partially_filled', 'filled', 'cancel_requested', 'cancelled', 'expired', 'unknown'],
  partially_filled: ['partially_filled', 'filled', 'cancel_requested', 'cancelled', 'expired', 'unknown'],
  cancel_requested: ['cancelled', 'filled', 'partially_filled', 'unknown'],
  unknown: ['acknowledged', 'partially_filled', 'filled', 'rejected', 'cancelled', 'expired', 'unknown'],
  filled: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

export const TERMINAL_STATES: OrderState[] = ['filled', 'rejected', 'cancelled', 'expired'];

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionOrder(order: Order, to: OrderState, now: string, rejectReason?: string): Order {
  if (!canTransition(order.state, to)) {
    throw new Error(`Invalid order transition ${order.state} → ${to} for ${order.clientOrderId}`);
  }
  return { ...order, state: to, updatedAt: now, ...(rejectReason ? { rejectReason } : {}) };
}

export function isTerminal(state: OrderState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Orders still able to fill (exposure counts them). */
export function isWorking(state: OrderState): boolean {
  return ['pending_submission', 'submitted', 'acknowledged', 'partially_filled', 'cancel_requested', 'unknown'].includes(state);
}

export function remainingVolume(order: Order, step = 0.01): number {
  return normalize(order.volume - order.filledVolume, step);
}

/** Apply a provider-reported fill. Rejects overfills and fills on terminal orders. */
export function applyFill(order: Order, fill: Pick<Fill, 'volume' | 'price'>, now: string, step = 0.01): Order {
  if (!(fill.volume > 0)) throw new Error('Fill volume must be positive.');
  if (isTerminal(order.state) && order.state !== 'filled') throw new Error(`Cannot fill an order in state ${order.state}.`);
  if (order.state === 'filled') throw new Error('Order is already fully filled.');
  const filled = normalize(order.filledVolume + fill.volume, step);
  if (filled > order.volume + step / 1000) throw new Error('Fill exceeds order volume.');
  const state: OrderState = filled + step / 1000 >= order.volume ? 'filled' : 'partially_filled';
  return { ...order, filledVolume: filled, state, updatedAt: now };
}

/** Volume-weighted average entry of all fills of an order. */
export function averageFillPrice(fills: Pick<Fill, 'price' | 'volume'>[], tickSize: number): number {
  const vol = fills.reduce((s, f) => s + f.volume, 0);
  if (!(vol > 0)) throw new Error('No fills.');
  const vwap = fills.reduce((s, f) => s + f.price * f.volume, 0) / vol;
  // VWAP may fall between ticks; round conservatively against the trader for display/levels.
  return normalize(Math.round(vwap / tickSize) * tickSize, tickSize);
}

/**
 * Target protective levels for a position given its ACTUAL fills.
 * SL = actual entry ∓ fixed distance; TP = active TP mode for the setup.
 */
export function targetLevelsForFills(
  signal: MasterSignal,
  fills: Pick<Fill, 'price' | 'volume'>[],
  tickSize: number,
): { entry: number; stopLoss: number; takeProfit: number; volume: number } {
  const entry = averageFillPrice(fills, tickSize);
  const volume = normalize(
    fills.reduce((s, f) => s + f.volume, 0),
    0.01,
  );
  return {
    entry,
    volume,
    stopLoss: computeStopLoss(signal.direction, entry, signal.strategy, tickSize),
    takeProfit: resolveTakeProfit(signal.takeProfit, signal.direction, entry, signal.strategy, tickSize),
  };
}

/**
 * Exposure for an account from working orders (remaining volume) and open positions,
 * in account currency. Orders/positions with unknown specs are counted as an error.
 */
export function computeExposure(
  account: TradingAccount,
  orders: Order[],
  positions: Position[],
  specFor: (symbol: string) => InstrumentSpec | undefined,
  now: Date,
): ExposureSummary & { errors: string[] } {
  const errors: string[] = [];
  let openRisk = 0;
  let pendingRisk = 0;
  for (const p of positions) {
    if (p.accountId !== account.id || p.status !== 'open') continue;
    const spec = specFor(p.symbol);
    const fx = spec ? fxFactor(account, spec, now).factor : undefined;
    if (!spec || fx === undefined) {
      errors.push(`Cannot value exposure for open ${p.symbol} position.`);
      continue;
    }
    openRisk += lossAtStop(p.entryPrice, p.stopLoss, p.volume, spec, fx) + (spec.commissionPerLot ?? 0) * p.volume;
  }
  for (const o of orders) {
    if (o.accountId !== account.id || !isWorking(o.state)) continue;
    const spec = specFor(o.symbol);
    const fx = spec ? fxFactor(account, spec, now).factor : undefined;
    if (!spec || fx === undefined) {
      errors.push(`Cannot value exposure for working ${o.symbol} order.`);
      continue;
    }
    const rem = remainingVolume(o, spec.volumeStep);
    pendingRisk += lossAtStop(o.limitPrice, o.stopLoss, rem, spec, fx) + (spec.commissionPerLot ?? 0) * rem;
  }
  return { openRisk: normalize(openRisk, 0.01), pendingRisk: normalize(pendingRisk, 0.01), errors };
}

/**
 * Profit/loss of a position in account currency: realised at its close price, or floating at
 * `price` while open (BUY values at the bid, SELL at the ask; the caller passes the right side).
 * Undefined when the broker spec, currency conversion or price is unavailable — never guessed.
 */
export function positionProfit(
  pos: Pick<Position, 'direction' | 'entryPrice' | 'volume' | 'status' | 'closePrice'>,
  price: number | undefined,
  account: TradingAccount,
  spec: InstrumentSpec | undefined,
  now: Date,
): number | undefined {
  const exit = pos.status === 'closed' ? pos.closePrice : price;
  if (exit === undefined || !spec) return undefined;
  const fx = fxFactor(account, spec, now).factor;
  if (fx === undefined) return undefined;
  return profitAt(pos.direction, pos.entryPrice, exit, pos.volume, spec, fx);
}
