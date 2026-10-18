/**
 * Execution preview: turns a master signal into per-account planned orders with
 * individual eligibility, protective levels, limit validity and risk results.
 *
 * Exposure is accumulated across the plan so that one account participating in
 * several groups — or several accounts in a capped group — cannot exceed limits.
 */
import { evaluateEligibility, type ExecutionContext } from './eligibility';
import { computeExposure, isTerminal } from './orders';
import { calculatePositionSize, type RiskResult } from './risk';
import { validateLimitOrder, type MarketContext } from './staging';
import { computeStopLoss, resolveTakeProfit, validateProtectiveLevels } from './strategy';
import type {
  AccountGroup,
  CompatibilityProfile,
  Direction,
  GroupEntryPlan,
  InstrumentSpec,
  MasterSignal,
  Order,
  OrderType,
  Position,
  TradingAccount,
} from './types';

export type PlannedOrderStatus = 'ready' | 'blocked' | 'awaiting_approval' | 'already_submitted';

export interface PlannedOrder {
  clientOrderId: string;
  signalId: string;
  groupId: string;
  groupName: string;
  accountId: string;
  accountName: string;
  currency: string;
  symbol: string;
  direction: Direction;
  orderType: OrderType;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  risk?: RiskResult;
  status: PlannedOrderStatus;
  blockers: string[];
  warnings: string[];
}

export interface PlanContext {
  accounts: TradingAccount[];
  groups: AccountGroup[];
  specs: InstrumentSpec[];
  profiles: CompatibilityProfile[];
  orders: Order[];
  positions: Position[];
  context: ExecutionContext;
  emergencyDisabled: boolean;
  /** Market data from the active provider. Unknown fields block submission. */
  market: MarketContext;
  now: Date;
}

/** Idempotency key: stable for the same signal/group/account, so retries cannot duplicate. */
export function clientOrderIdFor(signalId: string, groupId: string, accountId: string): string {
  return `${signalId}:${groupId}:${accountId}`;
}

export function findSpec(specs: InstrumentSpec[], serverId: string | undefined, symbol: string): InstrumentSpec | undefined {
  if (!serverId) return undefined;
  return specs.find((s) => s.serverId === serverId && s.symbol.toUpperCase() === symbol.toUpperCase());
}

export function orderTypeFor(direction: Direction, kind: GroupEntryPlan['orderKind']): OrderType {
  if (kind === 'market') return direction === 'BUY' ? 'BUY_MARKET' : 'SELL_MARKET';
  return direction === 'BUY' ? 'BUY_LIMIT' : 'SELL_LIMIT';
}

export function buildExecutionPlan(signal: MasterSignal, ctx: PlanContext): PlannedOrder[] {
  const out: PlannedOrder[] = [];
  // Running additional exposure per account / per group created by this plan.
  const addedAccountRisk = new Map<string, number>();
  const addedGroupRisk = new Map<string, number>();

  for (const gp of signal.groupPlans) {
    const group = ctx.groups.find((g) => g.id === gp.groupId);
    for (const accountId of group?.accountIds ?? []) {
      const account = ctx.accounts.find((a) => a.id === accountId);
      if (!account) continue;
      const spec = findSpec(ctx.specs, account.serverId, signal.symbol);
      const tick = spec?.tickSize ?? 0.01;
      const orderType = orderTypeFor(signal.direction, gp.orderKind);
      const clientOrderId = clientOrderIdFor(signal.id, gp.groupId, account.id);
      const blockers: string[] = [];
      const warnings: string[] = [];

      // Entry reference: limit price, or current market for a market entry (actual fill decides final levels).
      let entry = gp.entryPrice;
      if (gp.orderKind === 'market') {
        const px = signal.direction === 'BUY' ? ctx.market.ask : ctx.market.bid;
        if (gp.entryOffset !== 0) blockers.push('Market entry is only allowed for a zero-offset group.');
        if (px === undefined) blockers.push('Market price unknown; cannot size a market entry.');
        else entry = px;
        if (ctx.market.sessionOpen !== true) blockers.push('Trading session is closed or unknown.');
        warnings.push('Market entry: SL/TP will be re-based on the actual fill price.');
      }

      const stopLoss = computeStopLoss(signal.direction, entry, signal.strategy, tick);
      const takeProfit = resolveTakeProfit(signal.takeProfit, signal.direction, entry, signal.strategy, tick);
      const base = {
        clientOrderId,
        signalId: signal.id,
        groupId: gp.groupId,
        groupName: gp.groupName,
        accountId: account.id,
        accountName: account.displayName,
        currency: account.currency,
        symbol: signal.symbol,
        direction: signal.direction,
        orderType,
        entryPrice: entry,
        stopLoss,
        takeProfit,
      };

      const existing = ctx.orders.find((o) => o.clientOrderId === clientOrderId);
      if (existing) {
        out.push({
          ...base,
          status: 'already_submitted',
          blockers: [`Order already exists (${existing.state}); duplicate submission prevented.`],
          warnings,
        });
        continue;
      }

      if (!group) blockers.push('Group no longer exists.');
      else if (!group.enabled) blockers.push('Group is disabled.');

      const profile = ctx.profiles.find((p) => p.id === account.compatibilityProfileId);
      const elig = evaluateEligibility({
        account,
        symbol: signal.symbol,
        spec,
        profile,
        context: ctx.context,
        usesPendingOrders: gp.orderKind === 'limit',
        emergencyDisabled: ctx.emergencyDisabled,
      });
      blockers.push(...elig.reasons);
      warnings.push(...elig.warnings);

      let risk: RiskResult | undefined;
      if (spec) {
        const levels = validateProtectiveLevels(signal.direction, entry, stopLoss, takeProfit, spec.tickSize, spec.minStopDistance);
        blockers.push(...levels.errors);
        if (gp.orderKind === 'limit') blockers.push(...validateLimitOrder(signal.direction, entry, spec, ctx.market).errors);

        const exp = computeExposure(account, ctx.orders, ctx.positions, (sym) => findSpec(ctx.specs, account.serverId, sym), ctx.now);
        blockers.push(...exp.errors);
        const groupRemaining =
          group?.maxGroupRisk !== undefined ? group.maxGroupRisk - (addedGroupRisk.get(gp.groupId) ?? 0) : undefined;
        risk = calculatePositionSize({
          account,
          spec,
          entry,
          stopLoss,
          exposure: { openRisk: exp.openRisk, pendingRisk: exp.pendingRisk + (addedAccountRisk.get(account.id) ?? 0) },
          groupRiskRemaining: groupRemaining,
          now: ctx.now,
        });
        if (risk.status === 'rejected') blockers.push(...risk.reasons);
        if (risk.status === 'unverified' && ctx.context === 'live') blockers.push(...risk.reasons);
        if (risk.status === 'unverified' && ctx.context === 'simulation') warnings.push(...risk.reasons);
        warnings.push(...risk.warnings);
      }

      const status: PlannedOrderStatus = blockers.length
        ? 'blocked'
        : gp.requireApproval && !gp.approved
          ? 'awaiting_approval'
          : 'ready';
      if (status !== 'blocked' && risk && risk.volume > 0) {
        addedAccountRisk.set(account.id, (addedAccountRisk.get(account.id) ?? 0) + risk.riskAmount);
        addedGroupRisk.set(gp.groupId, (addedGroupRisk.get(gp.groupId) ?? 0) + risk.riskAmount);
      }
      out.push({ ...base, risk, status, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] });
    }
  }
  return out;
}

export function planSummary(plan: PlannedOrder[]) {
  return {
    ready: plan.filter((p) => p.status === 'ready').length,
    blocked: plan.filter((p) => p.status === 'blocked').length,
    awaitingApproval: plan.filter((p) => p.status === 'awaiting_approval').length,
    alreadySubmitted: plan.filter((p) => p.status === 'already_submitted').length,
    totalRisk: plan.filter((p) => p.status === 'ready').reduce((s, p) => s + (p.risk?.riskAmount ?? 0), 0),
  };
}

export function hasLiveOrders(orders: Order[], signalId: string): boolean {
  return orders.some((o) => o.signalId === signalId && !isTerminal(o.state));
}
