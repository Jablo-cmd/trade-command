/**
 * Master signal creation and validation.
 */
import { isOnTick } from './price';
import { buildGroupEntryPlans, validateOffsets } from './staging';
import type { AccountGroup, Direction, MasterSignal, StrategyConfig, TakeProfitMode } from './types';

export interface SignalDraft {
  symbol: string;
  direction: Direction;
  referenceEntry: number;
  strategy: StrategyConfig;
  extendedTp?: number;
  groupIds: string[];
  /** Use a market entry for zero-offset groups instead of a limit. */
  marketForZeroOffset: boolean;
  notes?: string;
}

export interface DraftValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSignalDraft(draft: SignalDraft, groups: AccountGroup[], tickSize: number): DraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!draft.symbol.trim()) errors.push('Symbol is required.');
  if (!(draft.referenceEntry > 0)) errors.push('Reference entry must be a positive price.');
  else if (!isOnTick(draft.referenceEntry, tickSize)) errors.push(`Reference entry must be a multiple of tick size ${tickSize}.`);
  if (!(draft.strategy.stopLossDistance > 0)) errors.push('Stop-loss distance must be positive.');
  if (!(draft.strategy.defaultTpPips > 0) || !(draft.strategy.strategyPipSize > 0)) errors.push('Default TP must be positive.');
  const selected = groups.filter((g) => draft.groupIds.includes(g.id));
  if (selected.length === 0) errors.push('Select at least one group.');
  if (selected.some((g) => !g.enabled)) warnings.push('Disabled groups are excluded from the plan.');
  if (selected.some((g) => g.accountIds.length === 0)) warnings.push('Some selected groups have no accounts.');
  const off = validateOffsets(selected, tickSize);
  errors.push(...off.errors);
  warnings.push(...off.warnings);
  if (draft.extendedTp !== undefined) {
    if (!(draft.extendedTp > 0)) errors.push('Extended TP must be a positive price.');
    else if (draft.direction === 'BUY' && draft.extendedTp <= draft.referenceEntry) errors.push('BUY extended TP must be above the reference entry.');
    else if (draft.direction === 'SELL' && draft.extendedTp >= draft.referenceEntry) errors.push('SELL extended TP must be below the reference entry.');
    else if (!isOnTick(draft.extendedTp, tickSize)) errors.push(`Extended TP must be a multiple of tick size ${tickSize}.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function createSignal(id: string, draft: SignalDraft, groups: AccountGroup[], tickSize: number, now: string): MasterSignal {
  const v = validateSignalDraft(draft, groups, tickSize);
  if (!v.ok) throw new Error(v.errors.join(' '));
  const selected = groups.filter((g) => draft.groupIds.includes(g.id));
  const takeProfit: TakeProfitMode =
    draft.extendedTp !== undefined ? { kind: 'extended_absolute', price: draft.extendedTp, activatedAt: now } : { kind: 'default_per_entry' };
  const groupPlans = buildGroupEntryPlans(selected, draft.referenceEntry, draft.direction, tickSize).map((gp) => ({
    ...gp,
    orderKind: draft.marketForZeroOffset && gp.entryOffset === 0 ? ('market' as const) : ('limit' as const),
  }));
  return {
    id,
    symbol: draft.symbol.toUpperCase(),
    direction: draft.direction,
    referenceEntry: draft.referenceEntry,
    strategy: draft.strategy,
    takeProfit,
    groupPlans,
    status: 'previewed',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    notes: draft.notes,
  };
}

export function approveGroup(signal: MasterSignal, groupId: string, now: string): MasterSignal {
  return {
    ...signal,
    groupPlans: signal.groupPlans.map((g) => (g.groupId === groupId ? { ...g, approved: true } : g)),
    revision: signal.revision + 1,
    updatedAt: now,
  };
}
