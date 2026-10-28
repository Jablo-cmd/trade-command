import { useEffect, useState } from 'react';
import { ORDER_STATE_LABELS, isWorking, positionProfit } from '../../domain/orders';
import type { Order, Position } from '../../domain/types';
import { Badge, Card, EmptyState, Field, NumberInput, PageHeader, Pnl, Toggle, fmtTime, useConfirm } from '../components';
import { ORDER_TONE } from '../labels';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

function SimulatorPanel() {
  const { data, busy } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const symbol = data.settings.strategy.symbol;
  const quote = store.simulator.snapshot().market[symbol];
  const faults = store.simulator.getFaults();
  const [bid, setBid] = useState<number | undefined>(quote?.bid);
  const [ask, setAsk] = useState<number | undefined>(quote?.ask);
  const [open, setOpen] = useState(quote?.sessionOpen ?? true);
  const nudge = (d: number) => {
    if (bid === undefined || ask === undefined) return;
    const b = Number((bid + d).toFixed(2));
    const a = Number((ask + d).toFixed(2));
    setBid(b);
    setAsk(a);
    void run(() => store.setSimulatedQuote(symbol, b, a, open));
  };
  return (
    <Card title={<>Simulator controls <Badge tone="sim">SIMULATION</Badge></>} className="sim-card">
      <p className="small">
        Quotes here are typed by you to drive the simulator. They are <strong>not live market data</strong>. Limits fill only when price trades through them by at least one tick.
      </p>
      <p className="small">
        Current simulated {symbol} quote: {quote?.bid !== undefined ? `${quote.bid} / ${quote.ask} (${quote.sessionOpen ? 'session open' : 'session closed'})` : 'none set'}
      </p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (bid !== undefined && ask !== undefined) void run(() => store.setSimulatedQuote(symbol, bid, ask, open));
        }}
      >
        <div className="grid2">
          <Field label="Simulated bid">{(id) => <NumberInput id={id} value={bid} onChange={setBid} min={0} required />}</Field>
          <Field label="Simulated ask">{(id) => <NumberInput id={id} value={ask} onChange={setAsk} min={0} required />}</Field>
        </div>
        <Toggle label="Session open" checked={open} onChange={setOpen} />
        <div className="row wrap">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Set simulated quote
          </button>
          <button className="btn btn-sm" type="button" onClick={() => nudge(-1)} disabled={busy}>
            −1.00
          </button>
          <button className="btn btn-sm" type="button" onClick={() => nudge(1)} disabled={busy}>
            +1.00
          </button>
        </div>
      </form>
      <details>
        <summary>Fault injection (test failure paths)</summary>
        <Toggle label="Partial fills (50% on first touch)" checked={!!faults.partialFillRatio} onChange={(v) => run(() => store.setSimulatorFaults({ partialFillRatio: v ? 0.5 : undefined }))} />
        <Toggle label="Model price gaps (fill at better quote)" checked={!!faults.gapFillsAtMarket} onChange={(v) => run(() => store.setSimulatorFaults({ gapFillsAtMarket: v }))} />
        <fieldset>
          <legend>Per-account faults</legend>
          {data.accounts.map((a) => (
            <div key={a.id} className="fault-row">
              <span className="small">{a.displayName}</span>
              <label className="check">
                <input
                  type="checkbox"
                  checked={faults.rejectAccounts.includes(a.id)}
                  onChange={(e) => run(() => store.setSimulatorFaults({ rejectAccounts: e.target.checked ? [...faults.rejectAccounts, a.id] : faults.rejectAccounts.filter((x) => x !== a.id) }))}
                />
                <span>reject orders</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={faults.failModifyAccounts.includes(a.id)}
                  onChange={(e) => run(() => store.setSimulatorFaults({ failModifyAccounts: e.target.checked ? [...faults.failModifyAccounts, a.id] : faults.failModifyAccounts.filter((x) => x !== a.id) }))}
                />
                <span>fail TP changes</span>
              </label>
            </div>
          ))}
        </fieldset>
      </details>
    </Card>
  );
}

export function Orders() {
  const { data, busy } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [showHistory, setShowHistory] = useState(false);
  const name = (id: string) => data.accounts.find((a) => a.id === id)?.displayName ?? 'Unknown';
  const group = (id: string) => data.groups.find((g) => g.id === id)?.name ?? '—';
  const { orders, positions } = data.execution;
  const working = orders.filter((o) => isWorking(o.state));
  const history = orders.filter((o) => !isWorking(o.state));
  const open = positions.filter((p) => p.status === 'open');
  const closed = positions.filter((p) => p.status === 'closed');

  // Current quotes for open positions: the simulator's typed quote, or the live connector's tick.
  const [quotes, setQuotes] = useState<Record<string, { bid?: number; ask?: number }>>({});
  const symbols = [...new Set(open.map((p) => p.symbol))].join(',');
  useEffect(() => {
    let live = true;
    const load = () =>
      void Promise.all(symbols.split(',').filter(Boolean).map(async (s) => [s, await store.market(s)] as const)).then((rows) => live && setQuotes(Object.fromEntries(rows)));
    load();
    const t = store.provider.info.simulated ? undefined : setInterval(load, 5000);
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [store, symbols, data.execution.positions, data.settings.provider]);
  const [now] = useState(() => new Date());
  const profitOf = (p: Position): { value: number | undefined; currency: string } => {
    const acc = data.accounts.find((a) => a.id === p.accountId);
    const q = quotes[p.symbol];
    const price = p.direction === 'BUY' ? q?.bid : q?.ask;
    return { value: acc ? positionProfit(p, price, acc, store.specForAccount(p.accountId, p.symbol), now) : undefined, currency: acc?.currency ?? '' };
  };

  const orderRow = (o: Order) => (
    <li key={o.id} className="order-row">
      <div>
        <strong>{name(o.accountId)}</strong> <small className="muted">grp {group(o.groupId)}</small>
        {o.simulated && (
          <>
            {' '}
            <Badge tone="sim">SIM</Badge>
          </>
        )}
        <div className="small">
          {o.type.replace('_', ' ')} {o.volume} {o.symbol} @ {o.limitPrice} · SL {o.stopLoss} · TP {o.takeProfit}
          {o.filledVolume > 0 && ` · filled ${o.filledVolume}`}
        </div>
        {o.rejectReason && <div className="small bad-text">{o.rejectReason}</div>}
        <div className="muted small">{fmtTime(o.updatedAt)}</div>
      </div>
      <div className="order-side">
        <Badge tone={ORDER_TONE[o.state]}>{ORDER_STATE_LABELS[o.state]}</Badge>
        {isWorking(o.state) && o.state !== 'cancel_requested' && (
          <button className="btn btn-sm btn-danger-ghost" disabled={busy} onClick={() => ask('Cancel order?', <p>Request cancellation of this pending order? It may still fill before the provider processes the request.</p>, () => void run(() => store.cancelOrder(o.clientOrderId)), { label: 'Cancel order', danger: true })}>
            Cancel
          </button>
        )}
      </div>
    </li>
  );

  const posRow = (p: Position) => (
    <li key={p.id} className="order-row">
      <div>
        <strong>{name(p.accountId)}</strong> <small className="muted">grp {group(p.groupId)}</small> {p.simulated && <Badge tone="sim">SIM</Badge>}
        <div className="small">
          {p.direction} {p.volume} {p.symbol} @ {p.entryPrice} (actual fill) · SL {p.stopLoss} · TP {p.takeProfit}
        </div>
        {p.tpModification.state === 'requested' && <div className="small warn-text">TP change to {p.tpModification.requested} requested — awaiting confirmation</div>}
        {p.tpModification.state === 'failed' && (
          <div className="small bad-text">
            TP change to {p.tpModification.requested} FAILED: {p.tpModification.reason}. Current TP unchanged.
          </div>
        )}
        {p.status === 'closed' && (
          <div className="small">
            Closed @ {p.closePrice} · {fmtTime(p.closedAt)}
          </div>
        )}
      </div>
      <div className="order-side">
        <Badge tone={p.status === 'open' ? 'ok' : 'neutral'}>{p.status === 'open' ? 'Open' : 'Closed'}</Badge>
        <div className="pnl-block">
          <Pnl {...profitOf(p)} title={p.status === 'open' ? 'Floating profit/loss at the current quote, before commission and swap.' : 'Realised profit/loss at the close price, before commission and swap.'} />
          <small className="muted">{p.status === 'open' ? 'floating' : 'realised'}</small>
        </div>
      </div>
    </li>
  );

  return (
    <>
      <PageHeader
        title="Positions & orders"
        subtitle={`Provider: ${store.provider.info.name}`}
        actions={
          <>
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await store.refreshLive();
                  await store.reconcile();
                })
              }
            >
              {store.provider.info.serverValidated ? 'Refresh from MT5' : 'Reconcile'}
            </button>
            {data.settings.emergencyDisabled ? (
              <button className="btn btn-sm" onClick={() => ask('Clear emergency disable?', <p>New submissions will be allowed again. Previously cancelled orders are not restored.</p>, () => void run(() => store.clearEmergency()))}>
                Clear emergency
              </button>
            ) : (
              <button
                className="btn btn-danger"
                onClick={() =>
                  ask(
                    'EMERGENCY DISABLE',
                    <p>Cancel ALL working orders on every account and block new submissions? Open positions remain open with their existing SL/TP.</p>,
                    () => void run(() => store.emergencyDisable()),
                    { label: 'Disable everything', danger: true },
                  )
                }
              >
                Emergency disable
              </button>
            )}
          </>
        }
      />
      {store.provider.info.simulated && <SimulatorPanel />}
      <Card title={`Open positions (${open.length})`}>{open.length ? <ul className="rows">{open.map(posRow)}</ul> : <EmptyState title="No open positions">Positions appear only after a provider-reported fill.</EmptyState>}</Card>
      <Card title={`Pending / working orders (${working.length})`}>{working.length ? <ul className="rows">{working.map(orderRow)}</ul> : <EmptyState title="No working orders" />}</Card>
      <button className="btn btn-sm" onClick={() => setShowHistory((x) => !x)}>
        {showHistory ? 'Hide' : 'Show'} history ({history.length} orders, {closed.length} closed positions)
      </button>
      {showHistory && (
        <>
          <Card title="Order history">{history.length ? <ul className="rows">{history.map(orderRow)}</ul> : <p className="muted">None.</p>}</Card>
          <Card title="Closed positions">{closed.length ? <ul className="rows">{closed.map(posRow)}</ul> : <p className="muted">None.</p>}</Card>
        </>
      )}
      {dialog}
    </>
  );
}
