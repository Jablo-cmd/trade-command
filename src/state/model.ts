import type { ExecutionState } from '../execution/orchestrator';
import type { SimulatorSnapshot } from '../execution/simulator';
import {
  DEFAULT_GOLD_STRATEGY,
  type AccountGroup,
  type AuditEvent,
  type CompatibilityProfile,
  type InstrumentSpec,
  type MasterSignal,
  type ServerDirectoryEntry,
  type StrategyConfig,
  type TradingAccount,
} from '../domain/types';

export type ProviderChoice = 'simulator' | 'mt5_connector' | 'mt5_unavailable';

export interface AppSettings {
  emergencyDisabled: boolean;
  provider: ProviderChoice;
  strategy: StrategyConfig;
}

export interface AppData {
  schemaVersion: 1;
  accounts: TradingAccount[];
  servers: ServerDirectoryEntry[];
  specs: InstrumentSpec[];
  profiles: CompatibilityProfile[];
  groups: AccountGroup[];
  signals: MasterSignal[];
  execution: ExecutionState;
  audit: AuditEvent[];
  settings: AppSettings;
  simulator?: SimulatorSnapshot;
}

export function emptyData(): AppData {
  return {
    schemaVersion: 1,
    accounts: [],
    servers: [],
    specs: [],
    profiles: [],
    groups: [],
    signals: [],
    execution: { orders: [], fills: [], positions: [] },
    audit: [],
    settings: { emergencyDisabled: false, provider: 'simulator', strategy: { ...DEFAULT_GOLD_STRATEGY } },
  };
}
