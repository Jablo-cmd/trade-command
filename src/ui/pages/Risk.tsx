import { useState } from 'react';
import { computeExposure } from '../../domain/orders';
import { findSpec } from '../../domain/plan';
import { calculatePositionSize } from '../../domain/risk';
import { Badge, Card, EmptyState, PageHeader, fmtTime } from '../components';
import { RISK_TONE } from '../labels';
import { useAppState } from '../storeContext';

export function Risk() {
  const { data } = useAppState();
  const [now] = useState(() => new Date());
  const strat = data.settings.strategy;
  const sym = strat.symbol;
  return (
    <>
      <PageHeader
        title="Risk overview"
        subtitle={`Per-account limits, exposure and a sizing check for a ${strat.stopLossDistance.toFixed(2)} ${sym} stop distance. Sizing uses each server’s instrument spec.`}
      />
      {data.accounts.length === 0 && <EmptyState title="No accounts" />}
      <div className="list">
        {data.accounts.map((a) => {
          const spec = findSpec(data.specs, a.serverId, sym);
          const exp = computeExposure(a, data.execution.orders, data.execution.positions, (s) => findSpec(data.specs, a.serverId, s), now);
          // Illustrative sizing at an arbitrary entry: only the distance matters for risk per lot.
          const probe = calculatePositionSize({ account: a, spec, entry: 1000 + strat.stopLossDistance, stopLoss: 1000, exposure: exp, now });
          const rs = a.riskSettings;
          const snapAge = a.snapshot ? Math.round((now.getTime() - new Date(a.snapshot.asOf).getTime()) / 60000) : undefined;
          const stale = snapAge !== undefined && snapAge > rs.maxSnapshotAgeMinutes;
          const cur = a.currency;
          const v = (x?: number) => (x === undefined ? <span className="muted">not set</span> : `${x.toLocaleString()} ${cur}`);
          return (
            <Card key={a.id} title={a.displayName} actions={<Badge tone={RISK_TONE[probe.status]}>{probe.status === 'approved' ? 'Sizing OK' : probe.status}</Badge>}>
              <dl className="kv">
                <dt>Max risk / trade</dt>
                <dd>{v(rs.maxRiskPerTrade)}</dd>
                <dt>Daily loss limit</dt>
                <dd>{v(rs.dailyLossLimit)}</dd>
                <dt>Max drawdown</dt>
                <dd>{v(rs.maxTotalDrawdown)}</dd>
                <dt>Aggregate cap</dt>
                <dd>{v(rs.maxAggregateRisk)}</dd>
                <dt>Max volume</dt>
                <dd>{rs.maxVolume ?? <span className="muted">not set</span>}</dd>
                <dt>Open risk</dt>
                <dd>{exp.openRisk.toFixed(2)} {cur}</dd>
                <dt>Pending risk</dt>
                <dd>{exp.pendingRisk.toFixed(2)} {cur}</dd>
                <dt>Snapshot</dt>
                <dd>
                  {a.snapshot ? (
                    <>
                      bal {a.snapshot.balance.toLocaleString()} · eq {a.snapshot.equity.toLocaleString()} · {fmtTime(a.snapshot.asOf)} {stale && <Badge tone="bad">stale</Badge>}
                    </>
                  ) : (
                    <span className="muted">none</span>
                  )}
                </dd>
                <dt>{sym} spec</dt>
                <dd>{spec ? `${spec.verification.status.replace('_', ' ')}` : <Badge tone="bad">missing</Badge>}</dd>
                <dt>Sizing for {strat.stopLossDistance} stop</dt>
                <dd>
                  {probe.status !== 'rejected'
                    ? `${probe.volume} lots · ${probe.riskAmount.toFixed(2)} ${cur} (${probe.riskPerLot?.toFixed(2)} ${cur}/lot)`
                    : '—'}
                </dd>
              </dl>
              {[...probe.reasons, ...probe.warnings, ...exp.errors].length > 0 && (
                <ul className="reasons">
                  {[...probe.reasons, ...probe.warnings, ...exp.errors].map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
