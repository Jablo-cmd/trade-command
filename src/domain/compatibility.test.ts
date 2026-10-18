import { describe, expect, it } from 'vitest';
import { NOW_ISO, account, goldSpec, verifiedProfile } from '../test/fixtures';
import { emptyCompatibilityProfile, evaluateExecutionMode } from './compatibility';
import { evaluateEligibility } from './eligibility';

describe('execution mode evaluation', () => {
  it('blocks live automation when rules are unknown', () => {
    const r = evaluateExecutionMode(emptyCompatibilityProfile('p', 'Firm', 'Prog', NOW_ISO), 'live_automated');
    expect(r.allowed).toBe(false);
    expect(r.blockers.length).toBe(9);
  });
  it('blocks when there is no profile', () => {
    expect(evaluateExecutionMode(undefined, 'live_automated').allowed).toBe(false);
  });
  it('blocks a prohibited item', () => {
    const p = verifiedProfile();
    p.items.personalAccountCopying = { status: 'prohibited', source: 'rules', verifiedOn: '2026-01-01' };
    const r = evaluateExecutionMode(p, 'live_automated');
    expect(r.allowed).toBe(false);
    expect(r.blockers.join()).toMatch(/Copying between own accounts: prohibited/);
  });
  it('does not accept "permitted" without a source and date', () => {
    const p = verifiedProfile();
    p.items.eaOrApi = { status: 'permitted' };
    expect(evaluateExecutionMode(p, 'live_automated').allowed).toBe(false);
  });
  it('allows live only when every required item is verified', () => {
    expect(evaluateExecutionMode(verifiedProfile(), 'live_automated').allowed).toBe(true);
  });
  it('treats disabled as blocked and simulation as allowed', () => {
    expect(evaluateExecutionMode(undefined, 'disabled').allowed).toBe(false);
    expect(evaluateExecutionMode(undefined, 'simulation').allowed).toBe(true);
  });
  it('does not require pending-order permission for market-only usage', () => {
    const p = verifiedProfile();
    p.items.pendingOrders = { status: 'unknown' };
    expect(evaluateExecutionMode(p, 'live_automated', false).allowed).toBe(true);
    expect(evaluateExecutionMode(p, 'live_automated', true).allowed).toBe(false);
  });
});

describe('account eligibility', () => {
  const base = { symbol: 'XAUUSD', spec: goldSpec(), usesPendingOrders: true, emergencyDisabled: false };
  it('simulation eligibility needs enabled account, permission and spec', () => {
    expect(evaluateEligibility({ ...base, account: account(), context: 'simulation' }).eligible).toBe(true);
    expect(evaluateEligibility({ ...base, account: account({ tradingEnabled: false }), context: 'simulation' }).eligible).toBe(false);
    expect(evaluateEligibility({ ...base, account: account({ instrumentPermissions: ['EURUSD'] }), context: 'simulation' }).eligible).toBe(false);
    expect(evaluateEligibility({ ...base, spec: undefined, account: account(), context: 'simulation' }).eligible).toBe(false);
  });
  it('emergency disable blocks every account', () => {
    expect(evaluateEligibility({ ...base, emergencyDisabled: true, account: account(), context: 'simulation' }).eligible).toBe(false);
  });
  it('live context requires connection, verified rules, verified spec and provider metrics', () => {
    const r = evaluateEligibility({ ...base, account: account({ executionMode: 'live_automated' }), profile: verifiedProfile(), context: 'live' });
    expect(r.eligible).toBe(false);
    expect(r.reasons.join()).toMatch(/connection is simulated/);
    expect(r.reasons.join()).toMatch(/not provider-sourced/);
  });
  it('unknown execution mode for the account blocks live', () => {
    const r = evaluateEligibility({ ...base, account: account({ executionMode: 'manual_only', connectionStatus: 'connected' }), context: 'live' });
    expect(r.reasons.join()).toMatch(/not configured for live automated/);
    expect(r.reasons.join()).toMatch(/No prop-firm compatibility profile/);
  });
});
