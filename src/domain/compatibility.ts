/**
 * Prop-firm compatibility evaluation.
 *
 * Every rule defaults to `unknown`, and unknown is treated as not permitted for live
 * execution. The application never asserts that a firm allows a method; the owner must
 * record a source and verification date for each item.
 */
import {
  COMPATIBILITY_ITEMS,
  type CompatibilityItemKey,
  type CompatibilityProfile,
  type ExecutionMode,
  type RuleStatus,
} from './types';

export const COMPATIBILITY_LABELS: Record<CompatibilityItemKey, string> = {
  automatedExecution: 'Automated execution permitted',
  eaOrApi: 'EA / API usage permitted',
  vpsVpn: 'VPS / VPN usage',
  personalAccountCopying: 'Copying between own accounts',
  pendingOrders: 'Pending (limit) orders',
  hedgingNetting: 'Hedging / netting behaviour',
  instrumentRestrictions: 'Instrument restrictions (e.g. XAUUSD)',
  newsSessionRestrictions: 'News / session restrictions',
  programLimitations: 'Program-specific limitations',
};

export function emptyCompatibilityProfile(id: string, firm: string, program: string, now: string): CompatibilityProfile {
  const items = Object.fromEntries(COMPATIBILITY_ITEMS.map((k) => [k, { status: 'unknown' as RuleStatus }])) as CompatibilityProfile['items'];
  return { id, firm, program, items, updatedAt: now };
}

/** Items that must be verified before a given mode may be used for live execution. */
export function requiredItems(mode: ExecutionMode, usesPendingOrders: boolean): CompatibilityItemKey[] {
  if (mode === 'live_automated') {
    return COMPATIBILITY_ITEMS.filter((k) => usesPendingOrders || k !== 'pendingOrders');
  }
  if (mode === 'manual_only') {
    return ['instrumentRestrictions', 'newsSessionRestrictions', ...(usesPendingOrders ? (['pendingOrders'] as const) : [])];
  }
  return [];
}

export interface ModeEvaluation {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
}

export function evaluateExecutionMode(
  profile: CompatibilityProfile | undefined,
  mode: ExecutionMode,
  usesPendingOrders = true,
): ModeEvaluation {
  if (mode === 'disabled') return { allowed: false, blockers: ['Execution is disabled for this account.'], warnings: [] };
  if (mode === 'simulation') return { allowed: true, blockers: [], warnings: ['Simulation only — no broker orders are placed.'] };
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!profile) {
    return { allowed: false, blockers: ['No prop-firm compatibility profile is linked; rules are unverified.'], warnings };
  }
  for (const key of requiredItems(mode, usesPendingOrders)) {
    const item = profile.items[key];
    const label = COMPATIBILITY_LABELS[key];
    switch (item.status) {
      case 'unknown':
        blockers.push(`${label}: unverified.`);
        break;
      case 'prohibited':
        blockers.push(`${label}: prohibited.`);
        break;
      case 'conditional':
        if (!item.source || !item.verifiedOn) blockers.push(`${label}: conditional but no source/date recorded.`);
        else warnings.push(`${label}: conditional — ${item.notes ?? 'review conditions'}.`);
        break;
      case 'permitted':
        if (!item.source || !item.verifiedOn) blockers.push(`${label}: marked permitted without a source and verification date.`);
        break;
    }
  }
  return { allowed: blockers.length === 0, blockers, warnings };
}

export function compatibilitySummary(profile: CompatibilityProfile): Record<RuleStatus, number> {
  const out: Record<RuleStatus, number> = { unknown: 0, permitted: 0, conditional: 0, prohibited: 0 };
  for (const k of COMPATIBILITY_ITEMS) out[profile.items[k].status] += 1;
  return out;
}
