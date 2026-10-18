/**
 * Provider-neutral execution interface.
 *
 * A browser application is NOT a persistent execution engine. Real implementations of
 * this interface must run server-side (see docs/EXECUTION_ARCHITECTURE.md) and be reached
 * through an authenticated backend; the client only renders state.
 */
import type { MarketContext } from '../domain/staging';
import type { OrderState, OrderType } from '../domain/types';

export type ProviderConnectionState = 'unsupported' | 'disconnected' | 'unauthorized' | 'unverified' | 'connected';

export type ProviderErrorCode =
  | 'unsupported'
  | 'disconnected'
  | 'unauthorized'
  | 'unverified'
  | 'rejected'
  | 'not_found'
  | 'invalid_state'
  | 'unknown';

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; code: ProviderErrorCode; message: string };

export interface ProviderInfo {
  name: string;
  kind: 'simulator' | 'mt5' | 'other';
  /** True for any provider that does not reach a real broker. Always displayed in the UI. */
  simulated: boolean;
}

export interface ProviderCapabilities {
  pendingOrders: boolean;
  marketOrders: boolean;
  modifyProtection: boolean;
  cancelOrders: boolean;
  reconcile: boolean;
}

export interface SubmitOrderRequest {
  clientOrderId: string;
  accountId: string;
  symbol: string;
  type: OrderType;
  volume: number;
  price: number;
  stopLoss: number;
  takeProfit: number;
}

export interface ProviderOrder {
  providerOrderId: string;
  clientOrderId: string;
  accountId: string;
  symbol: string;
  type: OrderType;
  volume: number;
  filledVolume: number;
  price: number;
  stopLoss: number;
  takeProfit: number;
  state: OrderState;
  rejectReason?: string;
}

export interface ProviderFill {
  fillId: string;
  clientOrderId: string;
  accountId: string;
  price: number;
  volume: number;
  at: string;
}

export interface ProviderPosition {
  /** In hedging mode one position per order; keyed by the originating clientOrderId. */
  clientOrderId: string;
  accountId: string;
  symbol: string;
  volume: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  status: 'open' | 'closed';
  closePrice?: number;
  closedAt?: string;
}

export interface ProviderAccountInfo {
  balance: number;
  equity: number;
  currency: string;
  asOf: string;
}

export interface ModifyProtectionRequest {
  clientOrderId: string;
  target: 'order' | 'position';
  stopLoss: number;
  takeProfit: number;
}

export interface ExecutionProvider {
  readonly info: ProviderInfo;
  readonly capabilities: ProviderCapabilities;
  connectionState(accountId: string): Promise<ProviderConnectionState>;
  getMarket(symbol: string): Promise<ProviderResult<MarketContext>>;
  getAccountInfo(accountId: string): Promise<ProviderResult<ProviderAccountInfo>>;
  listOrders(): Promise<ProviderResult<ProviderOrder[]>>;
  listFills(): Promise<ProviderResult<ProviderFill[]>>;
  listPositions(): Promise<ProviderResult<ProviderPosition[]>>;
  /** Must be idempotent on clientOrderId: a repeated request returns the existing order. */
  submitOrder(req: SubmitOrderRequest): Promise<ProviderResult<ProviderOrder>>;
  modifyProtection(req: ModifyProtectionRequest): Promise<ProviderResult<{ stopLoss: number; takeProfit: number }>>;
  cancelOrder(clientOrderId: string): Promise<ProviderResult<ProviderOrder>>;
}
