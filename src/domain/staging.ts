/**
 * Staged-entry calculations: per-group entry levels derived from a master reference
 * price plus configurable offsets, and limit-order validity checks.
 *
 * A pending limit order is an intent, not a fill. Nothing here assumes price will
 * return to a staged level.
 */
import { addPrice, isOnTick } from './price';
import type { AccountGroup, Direction, GroupEntryPlan, InstrumentSpec } from './types';

/** BUY levels go below the reference; SELL levels go above it. */
export function computeEntryLevel(reference: number, direction: Direction, offset: number, tickSize: number): number {
  if (!Number.isFinite(offset) || offset < 0) throw new Error(`Offset must be ≥ 0 (got ${offset}).`);
  return addPrice(reference, direction === 'BUY' ? -offset : offset, tickSize);
}

export interface StagingValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate a set of group offsets before building a plan. */
export function validateOffsets(groups: Pick<AccountGroup, 'name' | 'entryOffset'>[], tickSize: number): StagingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<number, string>();
  for (const g of groups) {
    if (!Number.isFinite(g.entryOffset) || g.entryOffset < 0) errors.push(`${g.name}: offset must be zero or positive.`);
    else if (!isOnTick(g.entryOffset, tickSize)) errors.push(`${g.name}: offset ${g.entryOffset} is not a multiple of tick size ${tickSize}.`);
    const prev = seen.get(g.entryOffset);
    if (prev !== undefined) warnings.push(`${g.name} shares offset ${g.entryOffset} with ${prev}.`);
    seen.set(g.entryOffset, g.name);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Build per-group entry plans for enabled groups, ordered by sortOrder. */
export function buildGroupEntryPlans(
  groups: AccountGroup[],
  reference: number,
  direction: Direction,
  tickSize: number,
): GroupEntryPlan[] {
  return [...groups]
    .filter((g) => g.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => ({
      groupId: g.id,
      groupName: g.name,
      entryOffset: g.entryOffset,
      entryPrice: computeEntryLevel(reference, direction, g.entryOffset, tickSize),
      requireApproval: g.requireApproval,
      stagingMode: g.stagingMode,
      approved: !g.requireApproval,
      orderKind: 'limit' as const,
    }));
}

export interface MarketContext {
  /** Current price reported by a provider. Undefined = unknown (live submission must be blocked). */
  bid?: number;
  ask?: number;
  /** Whether the instrument is currently tradable per the provider. Undefined = unknown. */
  sessionOpen?: boolean;
}

/**
 * Validate a pending limit order:
 *  - BUY LIMIT must be below the current ask; SELL LIMIT above the current bid.
 *  - Must respect tick size and the broker's minimum distance from market.
 *  - Session must be open.
 * Missing market data yields an error (cannot verify) rather than a pass.
 */
export function validateLimitOrder(
  direction: Direction,
  limitPrice: number,
  spec: Pick<InstrumentSpec, 'tickSize' | 'minStopDistance'>,
  market: MarketContext,
): StagingValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isOnTick(limitPrice, spec.tickSize)) errors.push(`Limit ${limitPrice} is not a multiple of tick size ${spec.tickSize}.`);
  if (market.sessionOpen === false) errors.push('Trading session is closed for this instrument.');
  if (market.sessionOpen === undefined) errors.push('Trading session status is unknown.');
  const ref = direction === 'BUY' ? market.ask : market.bid;
  if (ref === undefined) {
    errors.push('Current market price is unknown; limit validity cannot be confirmed.');
  } else if (direction === 'BUY') {
    if (limitPrice >= ref) errors.push(`BUY LIMIT ${limitPrice} must be below current ask ${ref}.`);
    else if (ref - limitPrice + spec.tickSize / 1000 < spec.minStopDistance)
      errors.push(`BUY LIMIT is closer to market than broker minimum ${spec.minStopDistance}.`);
  } else {
    if (limitPrice <= ref) errors.push(`SELL LIMIT ${limitPrice} must be above current bid ${ref}.`);
    else if (limitPrice - ref + spec.tickSize / 1000 < spec.minStopDistance)
      errors.push(`SELL LIMIT is closer to market than broker minimum ${spec.minStopDistance}.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}
