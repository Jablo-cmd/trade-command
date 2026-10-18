/**
 * Price and volume arithmetic.
 *
 * Floating-point prices (e.g. 4080.07) are converted to integer tick counts for all
 * comparisons and rounding so that results are deterministic.
 */

const EPSILON = 1e-9;

/** Number of decimal places implied by a step such as 0.01 → 2. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid step: ${step}`);
  const s = step.toString();
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Round a value to the precision of `step` to remove float noise (not to a step multiple). */
export function normalize(value: number, step: number): number {
  return Number(value.toFixed(decimalsOf(step)));
}

/** Price expressed as an integer number of ticks. Throws if not on a tick boundary. */
export function toTicks(price: number, tickSize: number): number {
  const raw = price / tickSize;
  const rounded = Math.round(raw);
  if (Math.abs(raw - rounded) > 1e-6) {
    throw new Error(`Price ${price} is not a multiple of tick size ${tickSize}`);
  }
  return rounded;
}

export function isOnTick(price: number, tickSize: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(tickSize) || tickSize <= 0) return false;
  const raw = price / tickSize;
  return Math.abs(raw - Math.round(raw)) <= 1e-6;
}

export type TickRounding = 'nearest' | 'down' | 'up';

export function roundToTick(price: number, tickSize: number, mode: TickRounding = 'nearest'): number {
  const raw = price / tickSize;
  // Snap values that are within float noise of an integer before directional rounding.
  const snapped = Math.abs(raw - Math.round(raw)) <= 1e-6 ? Math.round(raw) : raw;
  const ticks = mode === 'down' ? Math.floor(snapped) : mode === 'up' ? Math.ceil(snapped) : Math.round(snapped);
  return normalize(ticks * tickSize, tickSize);
}

/** Add a signed price distance using tick arithmetic. */
export function addPrice(price: number, distance: number, tickSize: number): number {
  return normalize(price + distance, tickSize);
}

/**
 * Round a volume DOWN to the nearest valid step. Never rounds up, so risk is never
 * silently increased.
 */
export function floorToStep(volume: number, step: number): number {
  if (step <= 0) throw new Error(`Invalid volume step: ${step}`);
  const steps = Math.floor(volume / step + EPSILON);
  return normalize(steps * step, step);
}

export function isVolumeOnStep(volume: number, step: number): boolean {
  const raw = volume / step;
  return Math.abs(raw - Math.round(raw)) <= 1e-6;
}

export function formatPrice(price: number, tickSize = 0.01): string {
  return price.toFixed(decimalsOf(tickSize));
}

export function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
