import { useState } from 'react';
import { defaultTpDistance } from '../../domain/strategy';
import type { StrategyConfig } from '../../domain/types';
import { isSupabaseConfigured } from '../../state/supabaseConfig';
import { Badge, Card, Field, NumberInput, PageHeader, useConfirm } from '../components';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

export function Settings() {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [s, setS] = useState<StrategyConfig>(data.settings.strategy);

  const download = () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trade-command-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <PageHeader title="Settings" />
      <Card title="Execution provider">
        <div className="radio-list" role="radiogroup" aria-label="Execution provider">
          <label className="check">
            <input type="radio" name="provider" checked={data.settings.provider === 'simulator'} onChange={() => run(() => store.setProvider('simulator'))} />
            <span>
              Simulator <Badge tone="sim">no broker</Badge>
            </span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="provider"
              disabled={!store.connectorAvailable}
              checked={data.settings.provider === 'mt5_connector'}
              onChange={() =>
                ask(
                  'Switch to live MT5 execution?',
                  <>
                    <p>Authorised orders will be sent to MT5 through the connector on your Windows VPS.</p>
                    <ul className="reasons">
                      <li>The connector re-checks every order against live MT5 balances, your risk limits and each firm&apos;s recorded rules, and rejects anything that fails.</li>
                      <li>Real-money MT5 accounts are refused unless the VPS config explicitly allows them. Test on demo first.</li>
                      <li>Emergency disable cancels pending orders on every connected account.</li>
                    </ul>
                  </>,
                  () => run(() => store.setProvider('mt5_connector')),
                  { label: 'Use live MT5', danger: true },
                )
              }
            />
            <span>
              MT5 connector <Badge tone="bad">live</Badge>
            </span>
          </label>
        </div>
        <p className="small muted">
          {store.connectorAvailable
            ? 'The MT5 connector runs on your Windows VPS. Setup guide: docs/MT5_VPS_SETUP.md in the repository.'
            : 'The MT5 connector needs Supabase sign-in, which this local-only build does not have.'}
        </p>
      </Card>

      <Card title="Strategy defaults">
        <p className="small muted">
          Owner convention for {s.symbol}: {s.defaultTpPips} strategy pips × {s.strategyPipSize} = {defaultTpDistance(s).toFixed(2)} TP distance; SL {s.stopLossDistance.toFixed(2)} price move from actual entry. These are not broker definitions.
        </p>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => store.setStrategy(s));
          }}
        >
          <div className="grid2">
            <Field label="Symbol">{(id) => <input id={id} value={s.symbol} onChange={(e) => setS({ ...s, symbol: e.target.value.toUpperCase() })} />}</Field>
            <Field label="Default TP (strategy pips)">{(id) => <NumberInput id={id} value={s.defaultTpPips} onChange={(v) => setS({ ...s, defaultTpPips: v ?? 0 })} />}</Field>
            <Field label="Strategy pip size (price units)">{(id) => <NumberInput id={id} value={s.strategyPipSize} onChange={(v) => setS({ ...s, strategyPipSize: v ?? 0 })} />}</Field>
            <Field label="Stop-loss distance (price units)">{(id) => <NumberInput id={id} value={s.stopLossDistance} onChange={(v) => setS({ ...s, stopLossDistance: v ?? 0 })} />}</Field>
          </div>
          <button className="btn btn-primary" type="submit">
            Save strategy defaults
          </button>
        </form>
      </Card>

      <Card title="Data & storage">
        <p className="small">
          Storage: <Badge>{isSupabaseConfigured() ? 'Supabase configured (see README)' : 'This browser only (local)'}</Badge>
        </p>
        <p className="small muted">No passwords or broker credentials are collected or stored.</p>
        <div className="row wrap">
          <button className="btn" onClick={download}>
            Export backup
          </button>
          <label className="btn file-btn">
            Import backup
            <input
              type="file"
              accept="application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then((t) => ask('Replace all data?', <p>Importing replaces everything in this browser.</p>, () => run(() => store.importJson(t)), { label: 'Import', danger: true }));
              }}
            />
          </label>
          <button className="btn" onClick={() => run(() => store.loadDemoData())} disabled={data.accounts.length > 0 || data.groups.length > 0}>
            Load demo fixtures
          </button>
          <button className="btn btn-danger-ghost" onClick={() => ask('Erase all local data?', <p>This cannot be undone. Export a backup first.</p>, () => run(() => store.resetAll()), { label: 'Erase', danger: true })}>
            Erase local data
          </button>
        </div>
        <p className="small muted">Demo fixtures use a fictional firm/server and an illustrative, unverified XAUUSD spec. They are labelled DEMO everywhere.</p>
      </Card>
      {dialog}
    </>
  );
}
