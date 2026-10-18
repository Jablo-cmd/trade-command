import { useEffect, useState } from 'react';
import type { ExtendedTpPreview } from '../../domain/extendedTp';
import { planSummary, type PlannedOrder } from '../../domain/plan';
import type { SignalDraft } from '../../domain/signal';
import { defaultTpDistance } from '../../domain/strategy';
import type { Direction, MasterSignal } from '../../domain/types';
import { Badge, Card, ConfirmDialog, EmptyState, Field, List, NumberInput, PageHeader, Toggle, fmtTime, useConfirm } from '../components';
import { PLAN_STATUS, RISK_TONE } from '../labels';
import type { Route } from '../router';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

function NewSignalForm({ onCreated }: { onCreated: () => void }) {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const groups = [...data.groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const [d, setD] = useState<SignalDraft>({
    symbol: data.settings.strategy.symbol,
    direction: 'BUY',
    referenceEntry: undefined as unknown as number,
    strategy: { ...data.settings.strategy },
    groupIds: groups.filter((g) => g.enabled).map((g) => g.id),
    marketForZeroOffset: false,
  });
  const [useExt, setUseExt] = useState(false);
  const toggle = (id: string) => setD((p) => ({ ...p, groupIds: p.groupIds.includes(id) ? p.groupIds.filter((x) => x !== id) : [...p.groupIds, id] }));
  const tpDist = defaultTpDistance(d.strategy);

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const draft = { ...d, extendedTp: useExt ? d.extendedTp : undefined };
        if (run(() => store.createSignal(draft))) onCreated();
      }}
    >
      <div className="grid2">
        <Field label="Symbol">{(id) => <input id={id} required value={d.symbol} onChange={(e) => setD({ ...d, symbol: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Direction">
          {(id) => (
            <div className="segmented" id={id} role="radiogroup" aria-label="Direction">
              {(['BUY', 'SELL'] as Direction[]).map((x) => (
                <button key={x} type="button" role="radio" aria-checked={d.direction === x} className={d.direction === x ? `on ${x.toLowerCase()}` : ''} onClick={() => setD({ ...d, direction: x })}>
                  {x}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Reference entry price" hint="Your master level. Not live market data.">
          {(id) => <NumberInput id={id} value={d.referenceEntry} onChange={(v) => setD({ ...d, referenceEntry: v as number })} min={0} required />}
        </Field>
      </div>
      <fieldset>
        <legend>Strategy convention (owner-defined, not a broker definition)</legend>
        <div className="grid3">
          <Field label="Default TP (strategy pips)">{(id) => <NumberInput id={id} value={d.strategy.defaultTpPips} onChange={(v) => setD({ ...d, strategy: { ...d.strategy, defaultTpPips: v ?? 0 } })} min={0} />}</Field>
          <Field label="Strategy pip size (price)">{(id) => <NumberInput id={id} value={d.strategy.strategyPipSize} onChange={(v) => setD({ ...d, strategy: { ...d.strategy, strategyPipSize: v ?? 0 } })} min={0} />}</Field>
          <Field label="Stop-loss distance (price)">{(id) => <NumberInput id={id} value={d.strategy.stopLossDistance} onChange={(v) => setD({ ...d, strategy: { ...d.strategy, stopLossDistance: v ?? 0 } })} min={0} />}</Field>
        </div>
        <p className="muted small">
          Default TP = actual entry {d.direction === 'BUY' ? '+' : '−'} {tpDist.toFixed(2)}; SL = actual entry {d.direction === 'BUY' ? '−' : '+'} {d.strategy.stopLossDistance.toFixed(2)} (a price move, not a monetary loss).
        </p>
      </fieldset>
      <Toggle label="Use an extended TP (shared absolute price)" checked={useExt} onChange={setUseExt} />
      {useExt && (
        <Field label="Extended TP price">{(id) => <NumberInput id={id} value={d.extendedTp} onChange={(v) => setD({ ...d, extendedTp: v })} min={0} required />}</Field>
      )}
      <fieldset>
        <legend>Participating groups</legend>
        {groups.length === 0 && <p className="muted small">No groups configured.</p>}
        <div className="checklist">
          {groups.map((g) => (
            <label key={g.id} className="check">
              <input type="checkbox" checked={d.groupIds.includes(g.id)} onChange={() => toggle(g.id)} disabled={!g.enabled} />
              <span>
                {g.name} · offset {g.entryOffset} · {g.accountIds.length} acct · {g.stagingMode}
                {g.requireApproval && ' · approval'}
                {!g.enabled && ' · disabled'}
              </span>
            </label>
          ))}
        </div>
        <Toggle label="Use a market order for zero-offset groups (otherwise a limit)" checked={d.marketForZeroOffset} onChange={(v) => setD({ ...d, marketForZeroOffset: v })} />
      </fieldset>
      <Field label="Notes">{(id) => <input id={id} value={d.notes ?? ''} onChange={(e) => setD({ ...d, notes: e.target.value })} />}</Field>
      <button className="btn btn-primary" type="submit">
        Create signal &amp; preview
      </button>
    </form>
  );
}

function PlanTable({ plan }: { plan: PlannedOrder[] }) {
  return (
    <div className="plan">
      {plan.map((p) => {
        const [label, tone] = PLAN_STATUS[p.status];
        return (
          <details key={p.clientOrderId} className={`plan-row plan-${p.status}`}>
            <summary>
              <span className="plan-main">
                <strong>{p.accountName}</strong> <small className="muted">grp {p.groupName}</small>
                <span className="small">
                  {p.orderType.replace('_', ' ')} @ {p.entryPrice.toFixed(2)} · SL {p.stopLoss.toFixed(2)} · TP {p.takeProfit.toFixed(2)}
                </span>
              </span>
              <span className="plan-side">
                <Badge tone={tone}>{label}</Badge>
                {p.risk && p.risk.volume > 0 && (
                  <span className="small">
                    {p.risk.volume} lots · risk {p.risk.riskAmount.toFixed(2)} {p.currency}
                  </span>
                )}
              </span>
            </summary>
            {p.risk && (
              <div className="small">
                Risk engine: <Badge tone={RISK_TONE[p.risk.status]}>{p.risk.status}</Badge>
                {p.risk.riskPerLot !== undefined && ` · ${p.risk.riskPerLot.toFixed(2)} ${p.currency}/lot at stop`}
                {p.risk.budget !== undefined && ` · budget ${p.risk.budget.toFixed(2)} ${p.currency}`}
                <ul className="reasons">
                  {p.risk.budgetLines.map((l) => (
                    <li key={l.label}>
                      {l.label}: {l.remaining === undefined ? 'not set' : `${l.remaining.toFixed(2)} ${p.currency}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.blockers.length > 0 && (
              <>
                <strong className="small">Blocked because:</strong>
                <List items={p.blockers} />
              </>
            )}
            {p.warnings.length > 0 && (
              <>
                <strong className="small">Warnings:</strong>
                <List items={p.warnings} />
              </>
            )}
          </details>
        );
      })}
    </div>
  );
}

function ExtendedTpControl({ signal }: { signal: MasterSignal }) {
  const store = useStoreInstance();
  const run = useAction();
  const [price, setPrice] = useState<number | undefined>(signal.takeProfit.kind === 'extended_absolute' ? signal.takeProfit.price : undefined);
  const [preview, setPreview] = useState<ExtendedTpPreview | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const active = signal.takeProfit.kind === 'extended_absolute';
  return (
    <div className="ext-tp">
      <h3>Take-profit mode</h3>
      <p className="small">
        {active ? (
          <>
            <Badge tone="warn">Extended</Badge> shared absolute target {signal.takeProfit.kind === 'extended_absolute' && signal.takeProfit.price} — applies to open positions, pending entries and later groups until reset.
          </>
        ) : (
          <>
            <Badge tone="info">Default</Badge> each position: actual entry {signal.direction === 'BUY' ? '+' : '−'} {defaultTpDistance(signal.strategy).toFixed(2)}.
          </>
        )}
      </p>
      <div className="row wrap">
        <NumberInput id={`ext-${signal.id}`} value={price} onChange={setPrice} min={0} placeholder="Extended TP price" />
        <button className="btn btn-sm" disabled={!price} onClick={() => price && void store.previewExtended(signal.id, price).then(setPreview)}>
          Review extended TP
        </button>
        {active && (
          <button className="btn btn-sm" onClick={() => setConfirmReset(true)}>
            Reset to default TP
          </button>
        )}
      </div>
      <ConfirmDialog
        open={!!preview}
        title={`Activate extended TP ${price}?`}
        confirmLabel="Send TP modifications"
        confirmDisabled={!preview?.validation.ok}
        onCancel={() => setPreview(null)}
        onConfirm={() => {
          setPreview(null);
          if (price) void run(() => store.activateExtended(signal.id, price));
        }}
      >
        {preview && (
          <>
            <List items={preview.validation.errors} />
            <p className="small">
              {preview.changes.length} item(s) will receive a TP modification request. Stop-losses are not changed. Each change is shown as pending until the provider confirms it.
            </p>
            <ul className="reasons">
              {preview.changes.map((c) => (
                <li key={c.id}>
                  {c.kind === 'position' ? 'Position' : 'Pending'} @ {c.entry}: TP {c.currentTp} → {c.newTp} (SL {c.stopLoss} unchanged)
                </li>
              ))}
            </ul>
          </>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmReset}
        title="Reset to default TP?"
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void run(() => store.resetExtended(signal.id));
        }}
      >
        <p>Each open position and pending entry will be asked to return to its own default TP from its entry price. SL is not changed.</p>
      </ConfirmDialog>
    </div>
  );
}

function SignalCard({ signal }: { signal: MasterSignal }) {
  const { data, busy } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [plan, setPlan] = useState<PlannedOrder[] | null>(null);

  useEffect(() => {
    let live = true;
    void store.previewPlan(signal.id).then((p) => live && setPlan(p));
    return () => {
      live = false;
    };
  }, [store, signal.id, data]);

  const done = signal.status === 'closed' || signal.status === 'cancelled';
  const sum = plan ? planSummary(plan) : null;
  const automatic = signal.groupPlans.filter((g) => g.stagingMode === 'automatic').map((g) => g.groupId);
  const readyIn = (ids: string[]) => (plan ?? []).filter((p) => p.status === 'ready' && ids.includes(p.groupId));
  const sim = store.provider.info.simulated;

  const authorize = (ids: string[], label: string) => {
    const ready = readyIn(ids);
    const risk = ready.reduce((s, p) => s + (p.risk?.riskAmount ?? 0), 0);
    ask(
      `Authorise ${label}?`,
      <>
        <p>
          {ready.length} order(s) will be sent to <strong>{store.provider.info.name}</strong>.
        </p>
        <p className="small">Combined risk at stops ≈ {risk.toFixed(2)} (account currencies). Pending limits are not guaranteed to fill.</p>
        <ul className="reasons">
          {ready.map((p) => (
            <li key={p.clientOrderId}>
              {p.accountName}: {p.orderType.replace('_', ' ')} {p.risk?.volume} @ {p.entryPrice}
            </li>
          ))}
        </ul>
      </>,
      () => void run(() => store.submitSignal(signal.id, ids)),
      { label: sim ? 'Submit to simulator' : 'Submit' },
    );
  };

  return (
    <Card
      title={
        <>
          <span className={`dir dir-${signal.direction.toLowerCase()}`}>{signal.direction}</span> {signal.symbol} @ {signal.referenceEntry}
        </>
      }
      actions={<Badge tone={signal.status === 'active' ? 'info' : done ? 'neutral' : 'warn'}>{signal.status}</Badge>}
    >
      <p className="muted small">
        Created {fmtTime(signal.createdAt)} · revision {signal.revision} · SL distance {signal.strategy.stopLossDistance}
        {signal.notes && ` · ${signal.notes}`}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Group</th>
            <th>Entry</th>
            <th>Type</th>
            <th>Mode</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {signal.groupPlans.map((g) => (
            <tr key={g.groupId}>
              <td>{g.groupName}</td>
              <td>{g.entryPrice.toFixed(2)}</td>
              <td>{g.orderKind}</td>
              <td>{g.stagingMode}</td>
              <td className="right">
                {g.requireApproval && !g.approved && !done ? (
                  <button className="btn btn-sm" onClick={() => run(() => store.approveSignalGroup(signal.id, g.groupId))}>
                    Approve
                  </button>
                ) : g.requireApproval ? (
                  <Badge tone="ok">approved</Badge>
                ) : null}{' '}
                {!done && g.stagingMode === 'manual' && (
                  <button className="btn btn-sm btn-primary" disabled={busy || readyIn([g.groupId]).length === 0} onClick={() => authorize([g.groupId], `group ${g.groupName}`)}>
                    Submit {g.groupName}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Execution preview (per account)</h3>
      {!plan && <p className="muted">Calculating…</p>}
      {plan && plan.length === 0 && <p className="muted">No accounts in the selected groups.</p>}
      {sum && plan && plan.length > 0 && (
        <>
          <div className="chips">
            <Badge tone="ok">{sum.ready} ready</Badge>
            <Badge tone="bad">{sum.blocked} blocked</Badge>
            <Badge tone="warn">{sum.awaitingApproval} awaiting approval</Badge>
            <Badge>{sum.alreadySubmitted} already submitted</Badge>
          </div>
          <PlanTable plan={plan} />
        </>
      )}
      {!done && (
        <div className="row wrap sticky-actions">
          {automatic.length > 0 && (
            <button className="btn btn-primary" disabled={busy || readyIn(automatic).length === 0} onClick={() => authorize(automatic, 'automatic groups')}>
              Authorise automatic groups ({readyIn(automatic).length})
            </button>
          )}
          <button
            className="btn btn-danger-ghost"
            onClick={() => ask('Cancel signal?', <p>All pending orders for this signal will be cancelled. Open positions keep their SL/TP.</p>, () => void run(() => store.cancelSignal(signal.id)), { label: 'Cancel signal', danger: true })}
          >
            Cancel signal
          </button>
        </div>
      )}
      {!done && <ExtendedTpControl signal={signal} />}
      {dialog}
    </Card>
  );
}

export function SignalPage({ go }: { go: (r: Route) => void }) {
  const { data } = useAppState();
  const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const live = data.signals.filter((s) => s.status !== 'closed' && s.status !== 'cancelled');
  const past = data.signals.filter((s) => s.status === 'closed' || s.status === 'cancelled');
  return (
    <>
      <PageHeader
        title="Master signal"
        subtitle="One signal, individually validated per account. Nothing is sent until you authorise it."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating((x) => !x)}>
            {creating ? 'Close form' : 'New signal'}
          </button>
        }
      />
      {creating && (
        <Card title="New master signal">
          {data.groups.length === 0 ? (
            <EmptyState title="Create groups first" action={<button className="btn" onClick={() => go('groups')}>Go to groups</button>} />
          ) : (
            <NewSignalForm onCreated={() => setCreating(false)} />
          )}
        </Card>
      )}
      {live.length === 0 && !creating && <EmptyState title="No active signals">Create a master signal to build a staged-entry plan.</EmptyState>}
      <div className="list">
        {live.map((s) => (
          <SignalCard key={s.id} signal={s} />
        ))}
      </div>
      {past.length > 0 && (
        <button className="btn btn-sm" onClick={() => setShowDone((x) => !x)}>
          {showDone ? 'Hide' : 'Show'} {past.length} closed/cancelled signal(s)
        </button>
      )}
      {showDone && (
        <div className="list">
          {past.map((s) => (
            <SignalCard key={s.id} signal={s} />
          ))}
        </div>
      )}
    </>
  );
}
