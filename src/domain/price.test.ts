import { describe, expect, it } from 'vitest';
import { decimalsOf, floorToStep, isOnTick, isVolumeOnStep, roundToTick, toTicks } from './price';

describe('price precision', () => {
  it('derives decimals from a step', () => {
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(1e-7)).toBe(7);
  });
  it('validates tick alignment without float noise', () => {
    expect(isOnTick(4080.07, 0.01)).toBe(true);
    expect(isOnTick(4080.075, 0.01)).toBe(false);
    expect(isOnTick(4080.05, 0.05)).toBe(true);
    expect(isOnTick(4080.07, 0.05)).toBe(false);
    expect(isOnTick(0.3, 0.1)).toBe(true);
  });
  it('converts to integer ticks and throws off-grid', () => {
    expect(toTicks(4080.07, 0.01)).toBe(408007);
    expect(() => toTicks(4080.075, 0.01)).toThrow();
  });
  it('rounds to tick in each direction', () => {
    expect(roundToTick(4080.074, 0.01)).toBe(4080.07);
    expect(roundToTick(4080.071, 0.01, 'up')).toBe(4080.08);
    expect(roundToTick(4080.079, 0.01, 'down')).toBe(4080.07);
    expect(roundToTick(4080.07, 0.01, 'up')).toBe(4080.07);
  });
});

describe('volume step rounding', () => {
  it('always rounds down', () => {
    expect(floorToStep(0.339, 0.01)).toBe(0.33);
    expect(floorToStep(1.999, 0.1)).toBe(1.9);
    expect(floorToStep(0.3, 0.1)).toBe(0.3); // 0.3/0.1 = 2.9999999999999996 in float
    expect(floorToStep(0.009, 0.01)).toBe(0);
  });
  it('validates step alignment', () => {
    expect(isVolumeOnStep(0.33, 0.01)).toBe(true);
    expect(isVolumeOnStep(0.335, 0.01)).toBe(false);
  });
});
