import { describe, expect, it } from 'vitest';
import { group } from '../test/fixtures';
import { buildGroupEntryPlans, computeEntryLevel, validateLimitOrder, validateOffsets } from './staging';

const GROUPS = [
  group({ id: 'A', name: 'A', sortOrder: 0, entryOffset: 0 }),
  group({ id: 'B', name: 'B', sortOrder: 1, entryOffset: 3 }),
  group({ id: 'C', name: 'C', sortOrder: 2, entryOffset: 5 }),
  group({ id: 'D', name: 'D', sortOrder: 3, entryOffset: 7 }),
  group({ id: 'E', name: 'E', sortOrder: 4, entryOffset: 9 }),
];

describe('group offsets', () => {
  it('builds the illustrative BUY ladder 4080/4077/4075/4073/4071', () => {
    const plans = buildGroupEntryPlans(GROUPS, 4080, 'BUY', 0.01);
    expect(plans.map((p) => p.entryPrice)).toEqual([4080, 4077, 4075, 4073, 4071]);
  });
  it('places SELL levels above the reference', () => {
    const plans = buildGroupEntryPlans(GROUPS, 4080, 'SELL', 0.01);
    expect(plans.map((p) => p.entryPrice)).toEqual([4080, 4083, 4085, 4087, 4089]);
  });
  it('respects sort order, skips disabled groups and supports arbitrary offsets', () => {
    const gs = [group({ id: 'x', name: 'X', sortOrder: 2, entryOffset: 2.5 }), group({ id: 'y', name: 'Y', sortOrder: 1, entryOffset: 1.25 }), group({ id: 'z', name: 'Z', enabled: false })];
    const plans = buildGroupEntryPlans(gs, 4080, 'BUY', 0.01);
    expect(plans.map((p) => [p.groupId, p.entryPrice])).toEqual([
      ['y', 4078.75],
      ['x', 4077.5],
    ]);
  });
  it('marks approval-required groups as not approved', () => {
    const plans = buildGroupEntryPlans([group({ requireApproval: true })], 4080, 'BUY', 0.01);
    expect(plans[0]!.approved).toBe(false);
  });
  it('rejects negative and off-tick offsets; warns on duplicates', () => {
    expect(() => computeEntryLevel(4080, 'BUY', -1, 0.01)).toThrow();
    const v = validateOffsets([{ name: 'A', entryOffset: 0.005 }, { name: 'B', entryOffset: -2 }, { name: 'C', entryOffset: 3 }, { name: 'D', entryOffset: 3 }], 0.01);
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(2);
    expect(v.warnings).toHaveLength(1);
  });
});

describe('limit order validity', () => {
  const spec = { tickSize: 0.01, minStopDistance: 0.5 };
  it('accepts a BUY LIMIT below the ask', () => {
    expect(validateLimitOrder('BUY', 4077, spec, { bid: 4079.8, ask: 4080, sessionOpen: true }).ok).toBe(true);
  });
  it('rejects a BUY LIMIT at or above the ask (would be marketable)', () => {
    expect(validateLimitOrder('BUY', 4080, spec, { bid: 4079.8, ask: 4080, sessionOpen: true }).ok).toBe(false);
  });
  it('rejects a SELL LIMIT below the bid', () => {
    expect(validateLimitOrder('SELL', 4079, spec, { bid: 4080, ask: 4080.2, sessionOpen: true }).ok).toBe(false);
  });
  it('enforces minimum distance from market', () => {
    const r = validateLimitOrder('BUY', 4079.8, spec, { bid: 4079.9, ask: 4080, sessionOpen: true });
    expect(r.errors.join()).toMatch(/broker minimum/);
  });
  it('blocks when market data or session status is unknown', () => {
    expect(validateLimitOrder('BUY', 4077, spec, {}).errors).toHaveLength(2);
    expect(validateLimitOrder('BUY', 4077, spec, { bid: 4079, ask: 4080, sessionOpen: false }).ok).toBe(false);
  });
  it('rejects off-tick limit prices', () => {
    expect(validateLimitOrder('BUY', 4077.005, spec, { bid: 4079, ask: 4080, sessionOpen: true }).ok).toBe(false);
  });
});
