/**
 * Manual extended take-profit override.
 *
 * The extended target is a shared ABSOLUTE price for the whole setup. It is distinct
 * from the default TP, which is computed per position from its actual entry.
 * Changing TP never changes stop-loss.
 */
import { isTerminal, isWorking } from './orders';
import { computeDefaultTakeProfit, validateExtendedTarget, type LevelCheck } from './strategy';
import type { MasterSignal, Order, Position } from './types';

export interface TpChange {
  kind: 'position' | 'order';
  id: string;
  accountId: string;
  entry: number;
  currentTp: number;
  newTp: number;
  stopLoss: number;
}

export interface ExtendedTpPreview {
  validation: LevelCheck;
  changes: TpChange[];
}

/** Preview the effect of activating an extended target. Nothing is changed. */
export function previewExtendedTp(
  signal: MasterSignal,
  target: number,
  orders: Order[],
  positions: Position[],
  tickSize: number,
  marketPrice?: number,
): ExtendedTpPreview {
  const openPositions = positions.filter((p) => p.signalId === signal.id && p.status === 'open');
  const workingOrders = orders.filter((o) => o.signalId === signal.id && isWorking(o.state) && o.state !== 'partially_filled');
  const entries = [
    ...openPositions.map((p) => p.entryPrice),
    ...workingOrders.map((o) => o.limitPrice),
    ...signal.groupPlans.map((g) => g.entryPrice),
  ];
  const validation = validateExtendedTarget(signal.direction, target, entries, tickSize, marketPrice);
  const changes: TpChange[] = [
    ...openPositions.map((p) => ({
      kind: 'position' as const,
      id: p.id,
      accountId: p.accountId,
      entry: p.entryPrice,
      currentTp: p.takeProfit,
      newTp: target,
      stopLoss: p.stopLoss,
    })),
    ...workingOrders.map((o) => ({
      kind: 'order' as const,
      id: o.id,
      accountId: o.accountId,
      entry: o.limitPrice,
      currentTp: o.takeProfit,
      newTp: target,
      stopLoss: o.stopLoss,
    })),
  ].filter((c) => c.currentTp !== c.newTp);
  return { validation, changes };
}

/** Preview reverting to the default per-entry TP. */
export function previewResetTp(signal: MasterSignal, orders: Order[], positions: Position[], tickSize: number): TpChange[] {
  const open = positions.filter((p) => p.signalId === signal.id && p.status === 'open');
  const working = orders.filter((o) => o.signalId === signal.id && isWorking(o.state) && o.state !== 'partially_filled');
  return [
    ...open.map((p) => ({
      kind: 'position' as const,
      id: p.id,
      accountId: p.accountId,
      entry: p.entryPrice,
      currentTp: p.takeProfit,
      newTp: computeDefaultTakeProfit(signal.direction, p.entryPrice, signal.strategy, tickSize),
      stopLoss: p.stopLoss,
    })),
    ...working.map((o) => ({
      kind: 'order' as const,
      id: o.id,
      accountId: o.accountId,
      entry: o.limitPrice,
      currentTp: o.takeProfit,
      newTp: computeDefaultTakeProfit(signal.direction, o.limitPrice, signal.strategy, tickSize),
      stopLoss: o.stopLoss,
    })),
  ].filter((c) => c.currentTp !== c.newTp);
}

export function activateExtendedTp(signal: MasterSignal, price: number, now: string): MasterSignal {
  if (signal.status === 'closed' || signal.status === 'cancelled') throw new Error('Cannot change TP on a closed setup.');
  return { ...signal, takeProfit: { kind: 'extended_absolute', price, activatedAt: now }, revision: signal.revision + 1, updatedAt: now };
}

export function resetExtendedTp(signal: MasterSignal, now: string): MasterSignal {
  return { ...signal, takeProfit: { kind: 'default_per_entry' }, revision: signal.revision + 1, updatedAt: now };
}

export function setupIsClosed(signal: MasterSignal, orders: Order[], positions: Position[]): boolean {
  const mine = orders.filter((o) => o.signalId === signal.id);
  return mine.length > 0 && mine.every((o) => isTerminal(o.state)) && positions.filter((p) => p.signalId === signal.id).every((p) => p.status === 'closed');
}
