import { describe, expect, it } from 'vitest';
import { NOW, NOW_ISO, account, goldSpec } from '../test/fixtures';
import { calculatePositionSize, lossAtStop } from './risk';

const noExposure = { openRisk: 0, pendingRisk: 0 };

describe('lot sizing from monetary budget and stop distance', () => {
  it('sizes 15.00 stop with 1 USD/tick/lot: 1500 USD per lot → 0.33 lots for 500 budget', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.status).toBe('approved');
    expect(r.riskPerLot).toBe(1500);
    expect(r.volume).toBe(0.33);
    expect(r.riskAmount).toBe(495);
  });

  it('uses the broker tick value — a different contract gives a different size', () => {
    const r = calculatePositionSize({
      account: account(),
      spec: goldSpec({ tickValue: 0.1, contractSize: 10 }),
      entry: 4080,
      stopLoss: 4065,
      exposure: noExposure,
      now: NOW,
    });
    expect(r.riskPerLot).toBe(150);
    expect(r.volume).toBe(3.33);
  });

  it('rounds DOWN to volume step', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec({ volumeStep: 0.1 }), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.volume).toBe(0.3);
    expect(r.riskAmount).toBe(450);
  });

  it('includes known commission in risk per lot', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec({ commissionPerLot: 7 }), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.riskPerLot).toBe(1507);
    expect(r.volume).toBe(0.33);
  });

  it('warns when commission is unknown', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec({ commissionPerLot: undefined }), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.warnings.join()).toMatch(/Commission is unknown/);
  });

  it('rejects instead of increasing risk when minimum volume exceeds budget', () => {
    const r = calculatePositionSize({
      account: account({ riskSettings: { maxRiskPerTrade: 10, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: noExposure,
      now: NOW,
    });
    expect(r.status).toBe('rejected');
    expect(r.volume).toBe(0);
    expect(r.reasons.join()).toMatch(/Minimum volume 0.01 lots would risk 15.00 USD/);
  });

  it('caps at broker and account max volume', () => {
    const r = calculatePositionSize({
      account: account({ riskSettings: { maxRiskPerTrade: 100000, maxVolume: 2, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: noExposure,
      now: NOW,
    });
    expect(r.volume).toBe(2);
    expect(r.warnings.join()).toMatch(/capped/);
  });
});

describe('account risk limits', () => {
  const snap = { balance: 100000, equity: 99000, dailyLossUsed: 1000, drawdownReference: 100000, source: 'manual_entry' as const, asOf: NOW_ISO };

  it('limits budget by remaining daily loss after existing exposure', () => {
    const r = calculatePositionSize({
      account: account({ snapshot: snap, riskSettings: { maxRiskPerTrade: 1000, dailyLossLimit: 2000, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: { openRisk: 300, pendingRisk: 400 },
      now: NOW,
    });
    // 2000 - 1000 used - 700 committed = 300
    expect(r.budget).toBe(300);
    expect(r.volume).toBe(0.2);
  });

  it('rejects when daily loss limit is exhausted', () => {
    const r = calculatePositionSize({
      account: account({ snapshot: { ...snap, dailyLossUsed: 2000 }, riskSettings: { maxRiskPerTrade: 1000, dailyLossLimit: 2000, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: noExposure,
      now: NOW,
    });
    expect(r.status).toBe('rejected');
    expect(r.reasons.join()).toMatch(/No risk budget remaining/);
  });

  it('limits budget by remaining total drawdown', () => {
    const r = calculatePositionSize({
      account: account({ snapshot: { ...snap, equity: 94500 }, riskSettings: { maxRiskPerTrade: 5000, maxTotalDrawdown: 6000, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: noExposure,
      now: NOW,
    });
    expect(r.budget).toBe(500);
    expect(r.volume).toBe(0.33);
  });

  it('applies combined aggregate and group exposure caps', () => {
    const r = calculatePositionSize({
      account: account({ riskSettings: { maxRiskPerTrade: 5000, maxAggregateRisk: 2000, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec(),
      entry: 4080,
      stopLoss: 4065,
      exposure: { openRisk: 1000, pendingRisk: 400 },
      groupRiskRemaining: 450,
      now: NOW,
    });
    expect(r.budget).toBe(450);
    expect(r.budgetLines.find((l) => l.label === 'Aggregate risk remaining')?.remaining).toBe(600);
  });

  it('rejects with a stale or missing snapshot when limits need it', () => {
    const stale = { ...snap, asOf: '2026-01-15T07:00:00.000Z' };
    const rs = { maxRiskPerTrade: 1000, dailyLossLimit: 2000, maxSnapshotAgeMinutes: 60 };
    expect(calculatePositionSize({ account: account({ snapshot: stale, riskSettings: rs }), spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW }).reasons.join()).toMatch(/older than 60/);
    expect(calculatePositionSize({ account: account({ riskSettings: rs }), spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW }).reasons.join()).toMatch(/snapshot is missing/);
  });

  it('rejects when max risk per trade is not configured (no invented defaults)', () => {
    const r = calculatePositionSize({ account: account({ riskSettings: { maxSnapshotAgeMinutes: 60 } }), spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.status).toBe('rejected');
  });
});

describe('instrument specification checks', () => {
  it('rejects when spec is missing', () => {
    const r = calculatePositionSize({ account: account(), spec: undefined, entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.status).toBe('rejected');
    expect(r.reasons[0]).toMatch(/missing/);
  });
  it('rejects invalid spec values', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec({ tickValue: 0, volumeStep: 0 }), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.status).toBe('rejected');
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
  it('marks result unverified when spec is user-supplied', () => {
    const r = calculatePositionSize({ account: account(), spec: goldSpec({ verification: { status: 'user_supplied' } }), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.status).toBe('unverified');
    expect(r.volume).toBe(0.33);
  });
  it('requires a fresh FX rate when profit currency differs', () => {
    const eur = account({ currency: 'EUR' });
    expect(calculatePositionSize({ account: eur, spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW }).status).toBe('rejected');
    const withFx = account({ currency: 'EUR', fxRates: { USD: { rate: 0.9, asOf: NOW_ISO } } });
    const r = calculatePositionSize({ account: withFx, spec: goldSpec(), entry: 4080, stopLoss: 4065, exposure: noExposure, now: NOW });
    expect(r.riskPerLot).toBeCloseTo(1350);
    expect(r.volume).toBe(0.37);
  });
  it('computes loss at stop for both directions', () => {
    expect(lossAtStop(4080, 4095, 0.5, goldSpec(), 1)).toBe(750);
  });
});
