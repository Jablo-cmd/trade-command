import type { Tone } from './components';
import type { ConnectionStatus, ExecutionMode, OrderState, RuleStatus, VerificationStatus } from '../domain/types';
import type { RiskStatus } from '../domain/risk';
import type { PlannedOrderStatus } from '../domain/plan';

export const CONNECTION: Record<ConnectionStatus, [string, Tone]> = {
  not_configured: ['No connection', 'neutral'],
  unsupported: ['Unsupported', 'bad'],
  disconnected: ['Disconnected', 'bad'],
  unauthorized: ['Unauthorised', 'bad'],
  unverified: ['Unverified', 'warn'],
  connected: ['Connected', 'ok'],
  simulated: ['Simulator only', 'sim'],
};

export const EXEC_MODE: Record<ExecutionMode, string> = {
  disabled: 'Disabled',
  manual_only: 'Manual only (app plans, you execute)',
  simulation: 'Simulation',
  live_automated: 'Live automated (requires verified connector)',
};

export const VERIFICATION: Record<VerificationStatus, [string, Tone]> = {
  verified: ['Verified', 'ok'],
  user_supplied: ['User-supplied · unverified', 'warn'],
  unknown: ['Unknown', 'neutral'],
};

export const RULE: Record<RuleStatus, [string, Tone]> = {
  unknown: ['Unknown', 'neutral'],
  permitted: ['Permitted', 'ok'],
  conditional: ['Conditional', 'warn'],
  prohibited: ['Prohibited', 'bad'],
};

export const ORDER_TONE: Record<OrderState, Tone> = {
  planned: 'neutral',
  pending_submission: 'info',
  submitted: 'info',
  acknowledged: 'info',
  partially_filled: 'warn',
  filled: 'ok',
  rejected: 'bad',
  cancel_requested: 'warn',
  cancelled: 'neutral',
  expired: 'neutral',
  unknown: 'bad',
};

export const RISK_TONE: Record<RiskStatus, Tone> = { approved: 'ok', unverified: 'warn', rejected: 'bad' };

export const PLAN_STATUS: Record<PlannedOrderStatus, [string, Tone]> = {
  ready: ['Ready', 'ok'],
  blocked: ['Blocked', 'bad'],
  awaiting_approval: ['Awaiting approval', 'warn'],
  already_submitted: ['Already submitted', 'neutral'],
};
