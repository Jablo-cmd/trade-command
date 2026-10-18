/**
 * Strategy convention (owner-defined) for take-profit and stop-loss levels.
 *
 * IMPORTANT: "30 pips = 3.00" is the owner's strategy convention for XAUUSD, not a
 * universal MT5 definition of a gold pip. The stop-loss is a 15.00 move in the quoted
 * price, NOT a 15 monetary loss. Monetary risk is computed separately by the risk
 * engine from the broker's verified contract specification.
 */
import { addPrice, isOnTick, normalize } from './price';
import type { Direction, StrategyConfig, TakeProfitMode } from './types';

/** Default TP distance in price units, e.g. 30 × 0.10 = 3.00. */
export function defaultTpDistance(cfg: StrategyConfig): number {
  return normalize(cfg.defaultTpPips * cfg.strategyPipSize, cfg.strategyPipSize / 10);
}

/** Default TP computed from a position's ACTUAL entry (fill) price. */
export function computeDefaultTakeProfit(
  direction: Direction,
  actualEntry: number,
  cfg: StrategyConfig,
  tickSize = 0.01,
): number {
  const d = defaultTpDistance(cfg);
  return addPrice(actualEntry, direction === 'BUY' ? d : -d, tickSize);
}

/** Fixed price-distance SL computed from a position's ACTUAL entry price. */
export function computeStopLoss(
  direction: Direction,
  actualEntry: number,
  cfg: StrategyConfig,
  tickSize = 0.01,
): number {
  const d = cfg.stopLossDistance;
  return addPrice(actualEntry, direction === 'BUY' ? -d : d, tickSize);
}

/** Active TP for an entry under the setup's TP mode. Extended mode is a shared absolute price. */
export function resolveTakeProfit(
  mode: TakeProfitMode,
  direction: Direction,
  entry: number,
  cfg: StrategyConfig,
  tickSize = 0.01,
): number {
  return mode.kind === 'extended_absolute'
    ? mode.price
    : computeDefaultTakeProfit(direction, entry, cfg, tickSize);
}

export interface LevelCheck {
  ok: boolean;
  errors: string[];
}

/**
 * Validate an absolute extended TP for a setup.
 * @param entries entry prices of every open position and pending order affected.
 * @param marketPrice current price if known; a BUY TP must be above it, SELL below.
 */
export function validateExtendedTarget(
  direction: Direction,
  target: number,
  entries: number[],
  tickSize: number,
  marketPrice?: number,
): LevelCheck {
  const errors: string[] = [];
  if (!Number.isFinite(target) || target <= 0) {
    errors.push('Extended target must be a positive price.');
    return { ok: false, errors };
  }
  if (!isOnTick(target, tickSize)) errors.push(`Target ${target} is not a multiple of tick size ${tickSize}.`);
  for (const e of entries) {
    if (direction === 'BUY' && target <= e) errors.push(`BUY target ${target} must be above entry ${e}.`);
    if (direction === 'SELL' && target >= e) errors.push(`SELL target ${target} must be below entry ${e}.`);
  }
  if (marketPrice !== undefined) {
    if (direction === 'BUY' && target <= marketPrice) errors.push(`BUY target must be above current price ${marketPrice}.`);
    if (direction === 'SELL' && target >= marketPrice) errors.push(`SELL target must be below current price ${marketPrice}.`);
  }
  return { ok: errors.length === 0, errors: dedupe(errors) };
}

/** Validate SL/TP placement against direction, tick size and the broker's minimum distance. */
export function validateProtectiveLevels(
  direction: Direction,
  entry: number,
  stopLoss: number,
  takeProfit: number,
  tickSize: number,
  minStopDistance: number,
): LevelCheck {
  const errors: string[] = [];
  for (const [label, v] of [
    ['Entry', entry],
    ['Stop-loss', stopLoss],
    ['Take-profit', takeProfit],
  ] as const) {
    if (!isOnTick(v, tickSize)) errors.push(`${label} ${v} is not a multiple of tick size ${tickSize}.`);
  }
  if (direction === 'BUY') {
    if (stopLoss >= entry) errors.push('BUY stop-loss must be below entry.');
    if (takeProfit <= entry) errors.push('BUY take-profit must be above entry.');
  } else {
    if (stopLoss <= entry) errors.push('SELL stop-loss must be above entry.');
    if (takeProfit >= entry) errors.push('SELL take-profit must be below entry.');
  }
  const tol = tickSize / 1000;
  if (minStopDistance > 0) {
    if (Math.abs(entry - stopLoss) + tol < minStopDistance) errors.push(`Stop-loss closer than broker minimum ${minStopDistance}.`);
    if (Math.abs(takeProfit - entry) + tol < minStopDistance) errors.push(`Take-profit closer than broker minimum ${minStopDistance}.`);
  }
  return { ok: errors.length === 0, errors };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
