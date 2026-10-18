/**
 * Per-account eligibility. A master signal never implies every account can execute it:
 * each account is checked individually.
 */
import { evaluateExecutionMode } from './compatibility';
import type { CompatibilityProfile, InstrumentSpec, TradingAccount } from './types';

export type ExecutionContext = 'simulation' | 'live';

export interface EligibilityInput {
  account: TradingAccount;
  symbol: string;
  spec?: InstrumentSpec;
  profile?: CompatibilityProfile;
  context: ExecutionContext;
  usesPendingOrders: boolean;
  /** Emergency kill switch state. */
  emergencyDisabled: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
  warnings: string[];
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { account, symbol, spec, profile, context } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (input.emergencyDisabled) reasons.push('Emergency disable is active.');
  if (!account.tradingEnabled) reasons.push('Trading is disabled for this account.');
  if (account.executionMode === 'disabled') reasons.push('Execution mode is disabled.');
  if (!account.instrumentPermissions.map((s) => s.toUpperCase()).includes(symbol.toUpperCase())) {
    reasons.push(`${symbol} is not in this account's instrument permissions.`);
  }
  if (!account.serverId) reasons.push('No server is assigned to this account.');
  if (!spec) reasons.push(`No ${symbol} instrument specification for this account's server.`);

  if (context === 'live') {
    if (account.executionMode !== 'live_automated') reasons.push('Account is not configured for live automated execution.');
    const mode = evaluateExecutionMode(profile, 'live_automated', input.usesPendingOrders);
    reasons.push(...mode.blockers);
    warnings.push(...mode.warnings);
    if (account.connectionStatus !== 'connected') reasons.push(`Broker connection is ${account.connectionStatus.replace('_', ' ')}.`);
    if (spec && spec.verification.status !== 'verified') reasons.push('Instrument specification is not verified.');
    if (account.snapshot?.source !== 'provider') reasons.push('Account metrics are not provider-sourced.');
  } else {
    warnings.push('Simulation only — orders go to the labelled simulator, never to a broker.');
  }

  return { eligible: reasons.length === 0, reasons, warnings };
}
