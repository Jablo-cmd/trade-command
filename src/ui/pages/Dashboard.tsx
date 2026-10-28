import { useState } from 'react';
import { evaluateExecutionMode } from '../../domain/compatibility';
import { isWorking } from '../../domain/orders';
import { findSpec } from '../../domain/plan';
import { MAX_ACCOUNTS } from '../../domain/types';
import { Badge, Card, EmptyState, PageHeader, fmtTime } from '../components';
import { CONNECTION } from '../labels';
import type { Route } from '../router';
import { useAppState, useStoreInstance } from '../storeContext';

export function Dashboard({ go }: { go: (r: Route) => void }) {
  const { data } = useAppState();
  const store = useStoreInstance();
  const { accounts, execution, signals } = data;
  const working = execution.orders.filter((o) => isWorking(o.state));
  const open = execution.positions.filter((p) => p.status === 'open');
  const activeSignals = signals.filter((s) => s.status === 'active' || s.status === 'previewed');
  const [now] = useState(() => Date.now());

  const riskWarnings: string[] = [];
  for (const a of accounts) {
    if (!a.tradingEnabled) continue;
    if (!a.riskSettings.maxRiskPerTrade) riskWarnings.push(`${a.displayName}: max risk per trade not set`);
    for (const sym of a.instrumentPermissions) {
      const spec = findSpec(data.specs, a.serverId, sym);
      if (!spec) riskWarnings.push(`${a.displayName}: no ${sym} instrument spec`);
      else if (spec.verification.status !== 'verified') riskWarnings.push(`${a.displayName}: ${sym} spec unverified`);
    }
    const needsSnap = a.riskSettings.dailyLossLimit !== undefined || a.riskSettings.maxTotalDrawdown !== undefined;
    if (needsSnap && (!a.snapshot || now - new Date(a.snapshot.asOf).getTime() > a.riskSettings.maxSnapshotAgeMinutes * 60000)) {
      riskWarnings.push(`${a.displayName}: balance/equity snapshot missing or stale`);
    }
  }
  const failures = [
    ...execution.orders.filter((o) => o.state === 'rejected' || o.state === 'unknown').map((o) => ({ id: o.id, text: `${name(o.accountId)}: order ${o.state}${o.rejectReason ? ` — ${o.rejectReason}` : ''}` })),
    ...execution.positions.filter((p) => p.tpModification.state === 'failed').map((p) => ({ id: p.id, text: `${name(p.accountId)}: TP modification failed — ${p.tpModification.reason ?? 'unknown reason'}` })),
  ];
  function name(id: string) {
    return accounts.find((a) => a.id === id)?.displayName ?? 'Unknown account';
  }

  const liveReady = accounts.filter((a) => {
    const p = data.profiles.find((x) => x.id === a.compatibilityProfileId);
    return evaluateExecutionMode(p, 'live_automated').allowed;
  }).length;

  const connCounts = accounts.reduce<Record<string, number>>((m, a) => ((m[a.connectionStatus] = (m[a.connectionStatus] ?? 0) + 1), m), {});

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`Execution provider: ${store.provider.info.name}`} />
      {accounts.length === 0 && (
        <EmptyState
          title="No trading accounts yet"
          action={
            <div className="row">
              <button className="btn btn-primary" onClick={() => go('accounts')}>
                Add an account
              </button>
              <button className="btn" onClick={() => go('settings')}>
                Load demo fixtures
              </button>
            </div>
          }
        >
          Add your accounts, servers and groups to build a staged-entry plan.
        </EmptyState>
      )}
      <div className="stats">
        <button className="stat" onClick={() => go('accounts')}>
          <span className="stat-value">
            {accounts.length}
            <small>/{MAX_ACCOUNTS}</small>
          </span>
          <span className="stat-label">Accounts configured</span>
        </button>
        <button className="stat" onClick={() => go('signal')}>
          <span className="stat-value">{activeSignals.length}</span>
          <span className="stat-label">Active signals</span>
        </button>
        <button className="stat" onClick={() => go('orders')}>
          <span className="stat-value">{working.length}</span>
          <span className="stat-label">Pending orders</span>
        </button>
        <button className="stat" onClick={() => go('orders')}>
          <span className="stat-value">{open.length}</span>
          <span className="stat-label">Open positions</span>
        </button>
      </div>

      <Card title="Connection & compatibility">
        <div className="chips">
          {Object.entries(connCounts).map(([k, n]) => {
            const [label, tone] = CONNECTION[k as keyof typeof CONNECTION];
            return (
              <Badge key={k} tone={tone}>
                {label}: {n}
              </Badge>
            );
          })}
          {accounts.length === 0 && <span className="muted">No accounts.</span>}
        </div>
        <p className="muted small">
          Firm rules verified for live automation on {liveReady} of {accounts.length} account(s). Live orders also need the MT5 connector running on your VPS.
        </p>
        <button className="btn btn-sm" onClick={() => go('compatibility')}>
          Review prop-firm rules
        </button>
      </Card>

      <Card title={`Risk warnings (${riskWarnings.length})`}>
        {riskWarnings.length ? (
          <ul className="reasons">
            {riskWarnings.slice(0, 8).map((w) => (
              <li key={w}>{w}</li>
            ))}
            {riskWarnings.length > 8 && <li>…and {riskWarnings.length - 8} more</li>}
          </ul>
        ) : (
          <p className="muted">No risk configuration warnings.</p>
        )}
      </Card>

      <Card title={`Account-level failures (${failures.length})`}>
        {failures.length ? (
          <ul className="reasons">
            {failures.slice(0, 8).map((f) => (
              <li key={f.id}>{f.text}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">No rejected, unknown or failed-modification items.</p>
        )}
      </Card>

      <Card title="Recent activity" actions={<button className="btn btn-sm" onClick={() => go('audit')}>All</button>}>
        {data.audit.length ? (
          <ul className="timeline">
            {data.audit.slice(0, 5).map((e) => (
              <li key={e.id}>
                <span className="muted small">{fmtTime(e.at)}</span> {e.simulated && <Badge tone="sim">SIM</Badge>} {e.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No events yet.</p>
        )}
      </Card>
    </>
  );
}
