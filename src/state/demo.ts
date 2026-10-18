/**
 * DEMO FIXTURES — fictional, clearly labelled data for exploring the workflow.
 * The firm, server, accounts and instrument specification are invented placeholders and
 * are marked `user_supplied` (unverified). They must never be mistaken for real data.
 */
import { emptyCompatibilityProfile } from '../domain/compatibility';
import type { AccountGroup, CompatibilityProfile, InstrumentSpec, ServerDirectoryEntry, TradingAccount } from '../domain/types';

export const DEMO_FIRM = 'DEMO Firm (fictional)';

export function buildDemoData(newId: () => string, now: string) {
  const server: ServerDirectoryEntry = {
    id: newId(),
    firm: DEMO_FIRM,
    serverName: 'DEMO-Server-Fictional',
    platform: 'MT5',
    origin: 'custom',
    verification: { status: 'user_supplied', source: 'Demo fixture — not a real server' },
    notes: 'Fictional entry for exploring the app.',
    createdAt: now,
    updatedAt: now,
  };
  const spec: InstrumentSpec = {
    id: newId(),
    serverId: server.id,
    symbol: 'XAUUSD',
    tickSize: 0.01,
    tickValue: 1,
    contractSize: 100,
    profitCurrency: 'USD',
    volumeMin: 0.01,
    volumeMax: 50,
    volumeStep: 0.01,
    minStopDistance: 0,
    verification: { status: 'user_supplied', source: 'Illustrative values — verify against your broker' },
    updatedAt: now,
  };
  const profile: CompatibilityProfile = emptyCompatibilityProfile(newId(), DEMO_FIRM, 'DEMO 100k', now);
  const accounts: TradingAccount[] = Array.from({ length: 5 }, (_, i) => ({
    id: newId(),
    displayName: `DEMO Account ${i + 1}`,
    firm: DEMO_FIRM,
    program: 'DEMO 100k',
    platform: 'MT5' as const,
    serverId: server.id,
    accountSize: 100000,
    currency: 'USD',
    tradingEnabled: true,
    executionMode: 'simulation' as const,
    instrumentPermissions: ['XAUUSD'],
    connectionStatus: 'simulated' as const,
    compatibilityProfileId: profile.id,
    riskSettings: { maxRiskPerTrade: 500, maxSnapshotAgeMinutes: 60 },
    notes: 'Demo fixture. Risk limit is a placeholder, not a recommendation.',
    createdAt: now,
    updatedAt: now,
  }));
  const offsets = [0, 3, 5, 7, 9];
  const groups: AccountGroup[] = offsets.map((offset, i) => ({
    id: newId(),
    name: String.fromCharCode(65 + i),
    sortOrder: i,
    enabled: true,
    stagingMode: 'automatic' as const,
    entryOffset: offset,
    requireApproval: false,
    accountIds: [accounts[i]!.id],
    createdAt: now,
    updatedAt: now,
  }));
  return { servers: [server], specs: [spec], profiles: [profile], accounts, groups };
}
