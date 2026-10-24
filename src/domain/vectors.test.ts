import { describe, expect, it } from 'vitest';
import { calculatePositionSize } from './risk';
import { computeDefaultTakeProfit, computeStopLoss } from './strategy';
import vectors from './__vectors__/strategy-risk.json';
import { NOW, account, goldSpec } from '../test/fixtures';
import type { Direction } from './types';

// The MT5 connector (connector/tests/test_vectors.py) runs the same vectors.
describe('shared strategy/risk vectors', () => {
  it.each(vectors.levels)('levels $direction @ $entry', (v) => {
    const cfg = { symbol: 'XAUUSD', strategyPipSize: v.pipSize, defaultTpPips: v.tpPips, stopLossDistance: v.slDistance };
    expect(computeStopLoss(v.direction as Direction, v.entry, cfg, v.tickSize)).toBe(v.sl);
    expect(computeDefaultTakeProfit(v.direction as Direction, v.entry, cfg, v.tickSize)).toBe(v.tp);
  });

  it.each(vectors.sizing)('sizing budget $budget step $vstep', (v) => {
    const r = calculatePositionSize({
      account: account({ riskSettings: { maxRiskPerTrade: v.budget, maxSnapshotAgeMinutes: 60 } }),
      spec: goldSpec({ tickSize: v.tickSize, tickValue: v.tickValue, commissionPerLot: v.commission, volumeMin: v.vmin, volumeMax: v.vmax, volumeStep: v.vstep }),
      entry: v.entry,
      stopLoss: v.sl,
      exposure: { openRisk: 0, pendingRisk: 0 },
      now: NOW,
    });
    expect(r.volume).toBe(v.volume);
    expect(r.riskAmount).toBe(v.risk);
  });
});
