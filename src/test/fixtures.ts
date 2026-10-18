/**
 * TEST FIXTURES — illustrative values only. They are not real broker specifications,
 * account balances or prop-firm rules.
 */
import { emptyCompatibilityProfile } from '../domain/compatibility';
import type { AccountGroup, CompatibilityProfile, InstrumentSpec, TradingAccount } from '../domain/types';
import { DEFAULT_GOLD_STRATEGY } from '../domain/types';

export const NOW = new Date('2026-01-15T10:00:00.000Z');
export const NOW_ISO = NOW.toISOString();
export const STRATEGY = DEFAULT_GOLD_STRATEGY;

/** Illustrative XAUUSD spec: 0.01 tick, 1.00 USD per tick per lot (100 oz contract). */
export function goldSpec(overrides: Partial<InstrumentSpec> = {}): InstrumentSpec {
  return {
    id: 'spec-1',
    serverId: 'srv-1',
    symbol: 'XAUUSD',
    tickSize: 0.01,
    tickValue: 1,
    contractSize: 100,
    profitCurrency: 'USD',
    volumeMin: 0.01,
    volumeMax: 50,
    volumeStep: 0.01,
    minStopDistance: 0,
    commissionPerLot: 0,
    verification: { status: 'verified', source: 'test fixture', verifiedOn: '2026-01-01' },
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function account(overrides: Partial<TradingAccount> = {}): TradingAccount {
  return {
    id: 'acc-1',
    displayName: 'Test Account 1',
    firm: 'Example Firm',
    program: 'Example 100k',
    platform: 'MT5',
    serverId: 'srv-1',
    accountSize: 100000,
    currency: 'USD',
    tradingEnabled: true,
    executionMode: 'simulation',
    instrumentPermissions: ['XAUUSD'],
    connectionStatus: 'simulated',
    riskSettings: { maxRiskPerTrade: 500, maxSnapshotAgeMinutes: 60 },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function group(overrides: Partial<AccountGroup> = {}): AccountGroup {
  return {
    id: 'grp-A',
    name: 'A',
    sortOrder: 0,
    enabled: true,
    stagingMode: 'automatic',
    entryOffset: 0,
    requireApproval: false,
    accountIds: ['acc-1'],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

export function verifiedProfile(): CompatibilityProfile {
  const p = emptyCompatibilityProfile('cp-1', 'Example Firm', 'Example 100k', NOW_ISO);
  for (const k of Object.keys(p.items) as (keyof typeof p.items)[]) {
    p.items[k] = { status: 'permitted', source: 'test fixture', verifiedOn: '2026-01-01' };
  }
  return p;
}
