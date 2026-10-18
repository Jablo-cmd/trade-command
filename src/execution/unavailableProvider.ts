/**
 * Placeholder for a future MT5 connector. It is NOT a connection: every call reports
 * `unsupported`. It exists so the UI and orchestrator exercise the real "no connector"
 * path instead of pretending an MT5 link exists.
 */
import type { ExecutionProvider, ProviderResult } from './provider';

const MESSAGE =
  'No MT5 connector is installed. A server-side connector (Windows host + MT5 terminal or an authorised API) is required. See docs/MT5_CONNECTOR.md.';

function unsupported<T>(): Promise<ProviderResult<T>> {
  return Promise.resolve({ ok: false, code: 'unsupported', message: MESSAGE });
}

export class UnavailableMt5Provider implements ExecutionProvider {
  readonly info = { name: 'MT5 (not connected — no connector installed)', kind: 'mt5' as const, simulated: false };
  readonly capabilities = { pendingOrders: false, marketOrders: false, modifyProtection: false, cancelOrders: false, reconcile: false };
  connectionState() {
    return Promise.resolve('unsupported' as const);
  }
  getMarket = () => unsupported<never>();
  getAccountInfo = () => unsupported<never>();
  listOrders = () => unsupported<never>();
  listFills = () => unsupported<never>();
  listPositions = () => unsupported<never>();
  submitOrder = () => unsupported<never>();
  modifyProtection = () => unsupported<never>();
  cancelOrder = () => unsupported<never>();
}

export const UNAVAILABLE_MT5_MESSAGE = MESSAGE;
