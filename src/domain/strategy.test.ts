import { describe, expect, it } from 'vitest';
import { STRATEGY } from '../test/fixtures';
import {
  computeDefaultTakeProfit,
  computeStopLoss,
  defaultTpDistance,
  resolveTakeProfit,
  validateExtendedTarget,
  validateProtectiveLevels,
} from './strategy';

describe('default 30-pip strategy convention', () => {
  it('defines 30 strategy pips on gold as a 3.00 price move', () => {
    expect(defaultTpDistance(STRATEGY)).toBe(3);
  });

  it('BUY TP = actual entry + 3.00', () => {
    expect(computeDefaultTakeProfit('BUY', 4080, STRATEGY)).toBe(4083);
    expect(computeDefaultTakeProfit('BUY', 4077, STRATEGY)).toBe(4080);
    expect(computeDefaultTakeProfit('BUY', 4079.37, STRATEGY)).toBe(4082.37);
  });

  it('SELL TP = actual entry - 3.00', () => {
    expect(computeDefaultTakeProfit('SELL', 4080, STRATEGY)).toBe(4077);
    expect(computeDefaultTakeProfit('SELL', 4080.11, STRATEGY)).toBe(4077.11);
  });
});

describe('stop-loss: fixed 15.00 price move (not a monetary amount)', () => {
  it('BUY SL = actual entry - 15.00', () => {
    expect(computeStopLoss('BUY', 4080, STRATEGY)).toBe(4065);
    expect(computeStopLoss('BUY', 4077, STRATEGY)).toBe(4062);
  });
  it('SELL SL = actual entry + 15.00', () => {
    expect(computeStopLoss('SELL', 4080, STRATEGY)).toBe(4095);
  });
  it('has no float noise for fractional entries', () => {
    expect(computeStopLoss('BUY', 4080.1, STRATEGY)).toBe(4065.1);
    expect(computeStopLoss('SELL', 4080.07, STRATEGY)).toBe(4095.07);
  });
});

describe('TP mode resolution', () => {
  it('default mode is per entry; extended mode is a shared absolute price', () => {
    expect(resolveTakeProfit({ kind: 'default_per_entry' }, 'BUY', 4077, STRATEGY)).toBe(4080);
    const ext = { kind: 'extended_absolute' as const, price: 4149, activatedAt: 'x' };
    expect(resolveTakeProfit(ext, 'BUY', 4077, STRATEGY)).toBe(4149);
    expect(resolveTakeProfit(ext, 'BUY', 4080, STRATEGY)).toBe(4149);
  });
});

describe('extended target validation', () => {
  it('accepts a BUY target above all entries', () => {
    expect(validateExtendedTarget('BUY', 4149, [4080, 4077, 4071], 0.01).ok).toBe(true);
  });
  it('rejects a BUY target at or below an entry', () => {
    const r = validateExtendedTarget('BUY', 4078, [4080, 4077], 0.01);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/above entry 4080/);
  });
  it('rejects a SELL target above an entry and checks market price', () => {
    expect(validateExtendedTarget('SELL', 4090, [4080], 0.01).ok).toBe(false);
    expect(validateExtendedTarget('SELL', 4000, [4080], 0.01, 3990).ok).toBe(false);
    expect(validateExtendedTarget('SELL', 4000, [4080], 0.01, 4050).ok).toBe(true);
  });
  it('rejects off-tick and non-positive targets', () => {
    expect(validateExtendedTarget('BUY', 4149.005, [4080], 0.01).ok).toBe(false);
    expect(validateExtendedTarget('BUY', -1, [4080], 0.01).ok).toBe(false);
  });
});

describe('protective level validation', () => {
  it('accepts valid BUY and SELL levels', () => {
    expect(validateProtectiveLevels('BUY', 4080, 4065, 4083, 0.01, 0).ok).toBe(true);
    expect(validateProtectiveLevels('SELL', 4080, 4095, 4077, 0.01, 0).ok).toBe(true);
  });
  it('rejects inverted levels', () => {
    expect(validateProtectiveLevels('BUY', 4080, 4095, 4077, 0.01, 0).errors).toHaveLength(2);
  });
  it('enforces broker minimum stop distance', () => {
    const r = validateProtectiveLevels('BUY', 4080, 4065, 4083, 0.01, 5);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/Take-profit closer than broker minimum/);
  });
  it('rejects prices not on the tick grid', () => {
    expect(validateProtectiveLevels('BUY', 4080.005, 4065, 4083, 0.01, 0).ok).toBe(false);
    expect(validateProtectiveLevels('BUY', 4080.1, 4065.1, 4083.1, 0.1, 0).ok).toBe(true);
  });
});
