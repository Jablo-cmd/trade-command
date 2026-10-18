/**
 * Deterministic risk engine.
 *
 * Position size = monetary risk budget ÷ (loss per 1.0 lot at the stop), rounded DOWN
 * to the broker's volume step. Loss per lot is derived from the broker's verified tick
 * size / tick value, converted to account currency, plus known commission.
 *
 * The engine never invents data. Missing or stale inputs produce a rejection or an
 * `unverified` result, and `unverified` results are never eligible for live execution.
 */
import { floorToStep, normalize } from './price';
import type { InstrumentSpec, TradingAccount } from './types';

export type RiskStatus = 'approved' | 'unverified' | 'rejected';

export interface ExposureSummary {
  /** Potential loss (account currency) if every open position hits its stop. */
  openRisk: number;
  /** Potential loss if every pending order fills and then hits its stop. */
  pendingRisk: number;
}

export interface RiskInput {
  account: TradingAccount;
  spec?: InstrumentSpec;
  entry: number;
  stopLoss: number;
  exposure: ExposureSummary;
  /** Remaining group-level risk budget, if the group defines one. */
  groupRiskRemaining?: number;
  now: Date;
}

export interface RiskBudgetLine {
  label: string;
  /** Remaining amount in account currency; undefined = limit not configured. */
  remaining?: number;
}

export interface RiskResult {
  status: RiskStatus;
  volume: number;
  /** Potential loss of the sized order at its stop, account currency. */
  riskAmount: number;
  riskPerLot?: number;
  budget?: number;
  budgetLines: RiskBudgetLine[];
  reasons: string[];
  warnings: string[];
}

const FX_MAX_AGE_MIN = 60;

function minutesBetween(a: Date, isoB: string): number {
  return (a.getTime() - new Date(isoB).getTime()) / 60000;
}

/** Conversion factor from instrument profit currency to the account currency. */
export function fxFactor(account: TradingAccount, spec: InstrumentSpec, now: Date): { factor?: number; error?: string } {
  if (spec.profitCurrency === account.currency) return { factor: 1 };
  const fx = account.fxRates?.[spec.profitCurrency];
  if (!fx || !(fx.rate > 0)) return { error: `No ${spec.profitCurrency}→${account.currency} conversion rate configured.` };
  if (minutesBetween(now, fx.asOf) > FX_MAX_AGE_MIN) return { error: `${spec.profitCurrency}→${account.currency} rate is stale.` };
  return { factor: fx.rate };
}

/** Monetary loss for `volume` lots between entry and stop, in account currency (commission excluded). */
export function lossAtStop(entry: number, stopLoss: number, volume: number, spec: InstrumentSpec, fx: number): number {
  const ticks = Math.abs(entry - stopLoss) / spec.tickSize;
  return ticks * spec.tickValue * volume * fx;
}

export function validateSpec(spec: InstrumentSpec | undefined): string[] {
  if (!spec) return ['Instrument specification is missing for this account/server.'];
  const errs: string[] = [];
  if (!(spec.tickSize > 0)) errs.push('Tick size must be positive.');
  if (!(spec.tickValue > 0)) errs.push('Tick value must be positive.');
  if (!(spec.volumeStep > 0)) errs.push('Volume step must be positive.');
  if (!(spec.volumeMin > 0)) errs.push('Minimum volume must be positive.');
  if (!(spec.volumeMax >= spec.volumeMin)) errs.push('Maximum volume must be ≥ minimum volume.');
  if (!(spec.minStopDistance >= 0)) errs.push('Minimum stop distance must be ≥ 0.');
  return errs;
}

export function calculatePositionSize(input: RiskInput): RiskResult {
  const { account, spec, entry, stopLoss, exposure, now } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const budgetLines: RiskBudgetLine[] = [];
  const reject = (extra: Partial<RiskResult> = {}): RiskResult => ({
    status: 'rejected',
    volume: 0,
    riskAmount: 0,
    budgetLines,
    reasons,
    warnings,
    ...extra,
  });

  const specErrors = validateSpec(spec);
  if (specErrors.length || !spec) {
    reasons.push(...specErrors);
    return reject();
  }
  if (!(Math.abs(entry - stopLoss) > 0)) {
    reasons.push('Entry and stop-loss must differ.');
    return reject();
  }

  const rs = account.riskSettings;
  if (rs.maxRiskPerTrade === undefined || !(rs.maxRiskPerTrade > 0)) {
    reasons.push('Maximum risk per trade is not configured for this account.');
    return reject();
  }

  const fx = fxFactor(account, spec, now);
  if (fx.factor === undefined) {
    reasons.push(fx.error ?? 'Currency conversion unavailable.');
    return reject();
  }

  const committed = exposure.openRisk + exposure.pendingRisk;
  budgetLines.push({ label: 'Max risk per trade', remaining: rs.maxRiskPerTrade });

  const needsSnapshot = rs.dailyLossLimit !== undefined || rs.maxTotalDrawdown !== undefined;
  const snap = account.snapshot;
  if (needsSnapshot) {
    if (!snap) {
      reasons.push('Balance/equity snapshot is missing; daily-loss and drawdown limits cannot be checked.');
      return reject();
    }
    if (minutesBetween(now, snap.asOf) > rs.maxSnapshotAgeMinutes) {
      reasons.push(`Balance/equity snapshot is older than ${rs.maxSnapshotAgeMinutes} minutes.`);
      return reject();
    }
  }
  if (rs.dailyLossLimit !== undefined && snap) {
    budgetLines.push({ label: 'Daily loss remaining', remaining: rs.dailyLossLimit - snap.dailyLossUsed - committed });
  }
  if (rs.maxTotalDrawdown !== undefined && snap) {
    const drawdownUsed = Math.max(0, snap.drawdownReference - snap.equity);
    budgetLines.push({ label: 'Total drawdown remaining', remaining: rs.maxTotalDrawdown - drawdownUsed - committed });
  }
  if (rs.maxAggregateRisk !== undefined) {
    budgetLines.push({ label: 'Aggregate risk remaining', remaining: rs.maxAggregateRisk - committed });
  }
  if (input.groupRiskRemaining !== undefined) {
    budgetLines.push({ label: 'Group risk remaining', remaining: input.groupRiskRemaining });
  }

  const budget = Math.min(...budgetLines.map((l) => l.remaining ?? Infinity));
  if (!(budget > 0)) {
    reasons.push('No risk budget remaining under the configured limits.');
    return reject({ budget });
  }

  const commission = spec.commissionPerLot;
  if (commission === undefined) warnings.push('Commission is unknown and not included in the risk estimate.');
  const riskPerLot = lossAtStop(entry, stopLoss, 1, spec, fx.factor) + (commission ?? 0);

  let volume = floorToStep(budget / riskPerLot, spec.volumeStep);
  const caps = [spec.volumeMax, rs.maxVolume ?? Infinity];
  const cap = Math.min(...caps);
  if (volume > cap) {
    volume = floorToStep(cap, spec.volumeStep);
    warnings.push(`Volume capped at ${volume} lots by maximum volume limit.`);
  }
  if (volume < spec.volumeMin) {
    const minRisk = normalize(riskPerLot * spec.volumeMin, 0.01);
    reasons.push(
      `Minimum volume ${spec.volumeMin} lots would risk ${minRisk.toFixed(2)} ${account.currency}, exceeding the available budget of ${budget.toFixed(2)} ${account.currency}.`,
    );
    return reject({ budget, riskPerLot });
  }

  const riskAmount = normalize(riskPerLot * volume, 0.01);
  const unverified = spec.verification.status !== 'verified';
  if (unverified) reasons.push('Instrument specification is not verified; result is illustrative and blocked from live execution.');
  if (snap && snap.source === 'simulation') warnings.push('Balance/equity snapshot comes from the simulator.');

  return {
    status: unverified ? 'unverified' : 'approved',
    volume,
    riskAmount,
    riskPerLot,
    budget,
    budgetLines,
    reasons,
    warnings,
  };
}
