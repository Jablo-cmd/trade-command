/**
 * Core domain model for Trade Command.
 *
 * These types are deliberately UI-agnostic and persistence-agnostic. All trading
 * calculations operate on these types and live in `src/domain/*`, never in components.
 */

export type Direction = 'BUY' | 'SELL';

export type ISODateString = string;

/** Hard product limit for V1. Also enforced by a database trigger. */
export const MAX_ACCOUNTS = 40;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * How trustworthy a piece of reference data is.
 * - `verified`: confirmed by the user against a named primary source on a recorded date.
 * - `user_supplied`: entered manually; not independently verified.
 * - `unknown`: not yet researched.
 */
export type VerificationStatus = 'verified' | 'user_supplied' | 'unknown';

export interface VerificationInfo {
  status: VerificationStatus;
  /** Where the information came from (URL, document, support ticket reference...). */
  source?: string;
  /** Date the source was checked (YYYY-MM-DD). */
  verifiedOn?: string;
}

// ---------------------------------------------------------------------------
// Server directory
// ---------------------------------------------------------------------------

export interface ServerDirectoryEntry {
  id: string;
  firm: string;
  serverName: string;
  platform: Platform;
  /** `custom` entries were typed in by the user and can be edited/removed. */
  origin: 'directory' | 'custom';
  verification: VerificationInfo;
  notes?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type Platform = 'MT5' | 'MT4' | 'cTrader' | 'DXtrade' | 'MatchTrader' | 'other';

// ---------------------------------------------------------------------------
// Instrument specifications
// ---------------------------------------------------------------------------

/**
 * Broker-specific contract specification for a symbol on a given server.
 * Never assume two brokers share the same XAUUSD specification.
 */
export interface InstrumentSpec {
  id: string;
  /** Server directory entry this specification applies to. */
  serverId: string;
  symbol: string;
  /** Smallest price increment, e.g. 0.01. */
  tickSize: number;
  /** Monetary value of one tick for 1.0 lot, in `profitCurrency`. */
  tickValue: number;
  /** Units per 1.0 lot (informational; tickValue drives risk maths). */
  contractSize: number;
  profitCurrency: string;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  /** Minimum distance (price units) between market and pending/stop levels; 0 if none. */
  minStopDistance: number;
  /** Estimated round-turn commission per 1.0 lot in account currency, if known. */
  commissionPerLot?: number;
  /** Price digits for display, derived from tickSize if omitted. */
  digits?: number;
  verification: VerificationInfo;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Compatibility (prop-firm rules)
// ---------------------------------------------------------------------------

/** Status of a single prop-firm rule item. Unknown is treated as NOT permitted. */
export type RuleStatus = 'unknown' | 'permitted' | 'conditional' | 'prohibited';

export const COMPATIBILITY_ITEMS = [
  'automatedExecution',
  'eaOrApi',
  'vpsVpn',
  'personalAccountCopying',
  'pendingOrders',
  'hedgingNetting',
  'instrumentRestrictions',
  'newsSessionRestrictions',
  'programLimitations',
] as const;

export type CompatibilityItemKey = (typeof COMPATIBILITY_ITEMS)[number];

export interface CompatibilityItem {
  status: RuleStatus;
  notes?: string;
  source?: string;
  verifiedOn?: string;
}

export interface CompatibilityProfile {
  id: string;
  firm: string;
  program: string;
  items: Record<CompatibilityItemKey, CompatibilityItem>;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Accounts and risk settings
// ---------------------------------------------------------------------------

export type ExecutionMode = 'disabled' | 'manual_only' | 'simulation' | 'live_automated';

/**
 * Connection status is reported by an execution provider. A server name alone
 * never implies `connected`.
 */
export type ConnectionStatus =
  | 'not_configured'
  | 'unsupported'
  | 'disconnected'
  | 'unauthorized'
  | 'unverified'
  | 'connected'
  | 'simulated';

export interface RiskSettings {
  /** Maximum monetary risk per trade in account currency. Undefined = not configured. */
  maxRiskPerTrade?: number;
  /** Maximum daily loss in account currency. */
  dailyLossLimit?: number;
  /** Maximum total drawdown in account currency (measured from `drawdownReference`). */
  maxTotalDrawdown?: number;
  /** Max lots for a single order on this account. */
  maxVolume?: number;
  /** Max aggregate risk (open + pending + new) in account currency. */
  maxAggregateRisk?: number;
  /** Maximum age of balance/equity snapshot before data is considered stale. */
  maxSnapshotAgeMinutes: number;
}

/** Account metrics snapshot. Must come from a provider or be typed in by the user; never invented. */
export interface AccountSnapshot {
  balance: number;
  equity: number;
  /** Realised + floating loss already incurred today, as a positive number. */
  dailyLossUsed: number;
  /** Balance used as drawdown reference (e.g. initial balance or high-water mark). */
  drawdownReference: number;
  /** Where the numbers came from. */
  source: 'manual_entry' | 'provider' | 'simulation';
  asOf: ISODateString;
}

export interface TradingAccount {
  id: string;
  displayName: string;
  firm: string;
  program: string;
  platform: Platform;
  serverId?: string;
  accountSize: number;
  currency: string;
  tradingEnabled: boolean;
  executionMode: ExecutionMode;
  /** Symbols this account may trade. Empty = none permitted. */
  instrumentPermissions: string[];
  connectionStatus: ConnectionStatus;
  compatibilityProfileId?: string;
  riskSettings: RiskSettings;
  snapshot?: AccountSnapshot;
  /** Conversion rate from instrument profit currency to account currency, when they differ. */
  fxRates?: Record<string, { rate: number; asOf: ISODateString }>;
  notes?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type StagingMode = 'manual' | 'automatic';

export interface AccountGroup {
  id: string;
  name: string;
  /** Display/execution order; lower first. */
  sortOrder: number;
  enabled: boolean;
  stagingMode: StagingMode;
  /**
   * Distance in price units from the master reference entry. 0 = at reference.
   * Applied below the reference for BUY and above it for SELL.
   */
  entryOffset: number;
  requireApproval: boolean;
  accountIds: string[];
  /** Optional group-level cap on combined new risk across its accounts. */
  maxGroupRisk?: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

// ---------------------------------------------------------------------------
// Strategy configuration
// ---------------------------------------------------------------------------

/**
 * User-defined strategy convention. These are NOT broker definitions.
 * The owner's convention: "30 pips" on gold = 3.00 of quoted price movement.
 */
export interface StrategyConfig {
  symbol: string;
  /** Strategy pip size in price units (gold convention: 0.10). */
  strategyPipSize: number;
  /** Default TP distance in strategy pips (30). */
  defaultTpPips: number;
  /** Fixed SL distance in price units from actual entry (15.00). */
  stopLossDistance: number;
}

export const DEFAULT_GOLD_STRATEGY: StrategyConfig = {
  symbol: 'XAUUSD',
  strategyPipSize: 0.1,
  defaultTpPips: 30,
  stopLossDistance: 15,
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalStatus = 'draft' | 'previewed' | 'authorized' | 'active' | 'closed' | 'cancelled';

export type TakeProfitMode =
  /** TP = each position's actual entry ± default distance. */
  | { kind: 'default_per_entry' }
  /** Shared absolute price for every position/pending order in the setup. */
  | { kind: 'extended_absolute'; price: number; activatedAt: ISODateString };

export interface MasterSignal {
  id: string;
  symbol: string;
  direction: Direction;
  referenceEntry: number;
  strategy: StrategyConfig;
  takeProfit: TakeProfitMode;
  /** Groups participating, in staging order, with the offsets captured at creation. */
  groupPlans: GroupEntryPlan[];
  status: SignalStatus;
  /** Bumped every time the signal plan is edited. */
  revision: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  notes?: string;
}

export interface GroupEntryPlan {
  groupId: string;
  groupName: string;
  entryOffset: number;
  entryPrice: number;
  requireApproval: boolean;
  stagingMode: StagingMode;
  approved: boolean;
  /** Market entry is only allowed for a zero-offset group; staged groups are always limits. */
  orderKind: 'limit' | 'market';
}

// ---------------------------------------------------------------------------
// Orders, fills, positions
// ---------------------------------------------------------------------------

export type OrderState =
  | 'planned'
  | 'pending_submission'
  | 'submitted'
  | 'acknowledged'
  | 'partially_filled'
  | 'filled'
  | 'rejected'
  | 'cancel_requested'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export type OrderType = 'BUY_LIMIT' | 'SELL_LIMIT' | 'BUY_MARKET' | 'SELL_MARKET';

export interface Order {
  id: string;
  /** Idempotency key: identical for retries of the same logical order. */
  clientOrderId: string;
  signalId: string;
  groupId: string;
  accountId: string;
  symbol: string;
  direction: Direction;
  type: OrderType;
  volume: number;
  filledVolume: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number;
  state: OrderState;
  providerOrderId?: string;
  providerName: string;
  simulated: boolean;
  rejectReason?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface Fill {
  id: string;
  orderId: string;
  accountId: string;
  price: number;
  volume: number;
  at: ISODateString;
  simulated: boolean;
}

export type ModificationState = 'none' | 'requested' | 'confirmed' | 'failed';

export interface Position {
  id: string;
  orderId: string;
  signalId: string;
  accountId: string;
  groupId: string;
  symbol: string;
  direction: Direction;
  volume: number;
  /** Volume-weighted average of actual fill prices. */
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Last TP change requested from the provider; shown as pending until confirmed. */
  tpModification: { state: ModificationState; requested?: number; reason?: string; at?: ISODateString };
  status: 'open' | 'closed';
  simulated: boolean;
  openedAt: ISODateString;
  closedAt?: ISODateString;
  closePrice?: number;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditCategory =
  | 'account'
  | 'server'
  | 'group'
  | 'signal'
  | 'order'
  | 'risk'
  | 'compatibility'
  | 'execution'
  | 'settings'
  | 'safety';

export interface AuditEvent {
  id: string;
  at: ISODateString;
  category: AuditCategory;
  action: string;
  entityId?: string;
  /** Short human-readable summary. */
  message: string;
  /** Sanitised structured details; never contains credentials. */
  details?: Record<string, unknown>;
  simulated?: boolean;
}
