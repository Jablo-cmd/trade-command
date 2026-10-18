import { useState } from 'react';
import { MAX_ACCOUNTS, type ExecutionMode, type Platform, type RiskSettings, type TradingAccount } from '../../domain/types';
import type { AccountInput } from '../../state/store';
import { Badge, Card, EmptyState, Field, NumberInput, PageHeader, Toggle, fmtTime, useConfirm } from '../components';
import { CONNECTION, EXEC_MODE } from '../labels';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

const PLATFORMS: Platform[] = ['MT5', 'MT4', 'cTrader', 'DXtrade', 'MatchTrader', 'other'];

function blank(): AccountInput {
  return {
    displayName: '',
    firm: '',
    program: '',
    platform: 'MT5',
    serverId: undefined,
    accountSize: 100000,
    currency: 'USD',
    tradingEnabled: false,
    executionMode: 'simulation',
    instrumentPermissions: ['XAUUSD'],
    riskSettings: { maxSnapshotAgeMinutes: 60 },
    notes: '',
  };
}

function AccountForm({ initial, onSave, onCancel }: { initial: AccountInput; onSave: (a: AccountInput) => void; onCancel: () => void }) {
  const { data } = useAppState();
  const [f, setF] = useState<AccountInput>(initial);
  const set = <K extends keyof AccountInput>(k: K, v: AccountInput[K]) => setF((p) => ({ ...p, [k]: v }));
  const setRisk = <K extends keyof RiskSettings>(k: K, v: RiskSettings[K]) => setF((p) => ({ ...p, riskSettings: { ...p.riskSettings, [k]: v } }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <div className="grid2">
        <Field label="Display name">{(id) => <input id={id} required value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />}</Field>
        <Field label="Prop firm">{(id) => <input id={id} required value={f.firm} onChange={(e) => set('firm', e.target.value)} />}</Field>
        <Field label="Program / account type">{(id) => <input id={id} value={f.program} onChange={(e) => set('program', e.target.value)} />}</Field>
        <Field label="Platform">
          {(id) => (
            <select id={id} value={f.platform} onChange={(e) => set('platform', e.target.value as Platform)}>
              {PLATFORMS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Server" hint="From your server directory. A server name does not imply a connection.">
          {(id) => (
            <select id={id} value={f.serverId ?? ''} onChange={(e) => set('serverId', e.target.value || undefined)}>
              <option value="">— none —</option>
              {data.servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.serverName} ({s.firm})
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Account size">{(id) => <NumberInput id={id} value={f.accountSize} onChange={(v) => set('accountSize', v ?? 0)} min={0} required />}</Field>
        <Field label="Account currency">{(id) => <input id={id} required maxLength={3} value={f.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />}</Field>
        <Field label="Execution mode">
          {(id) => (
            <select id={id} value={f.executionMode} onChange={(e) => set('executionMode', e.target.value as ExecutionMode)}>
              {(Object.keys(EXEC_MODE) as ExecutionMode[]).map((m) => (
                <option key={m} value={m}>
                  {EXEC_MODE[m]}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Instrument permissions" hint="Comma-separated symbols, e.g. XAUUSD">
          {(id) => <input id={id} value={f.instrumentPermissions.join(', ')} onChange={(e) => set('instrumentPermissions', e.target.value.split(','))} />}
        </Field>
        <Field label="Compatibility profile">
          {(id) => (
            <select id={id} value={f.compatibilityProfileId ?? ''} onChange={(e) => set('compatibilityProfileId', e.target.value || undefined)}>
              <option value="">— none (rules unverified) —</option>
              {data.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.firm} / {p.program}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Toggle label="Trading enabled" checked={f.tradingEnabled} onChange={(v) => set('tradingEnabled', v)} />

      <fieldset>
        <legend>Risk settings ({f.currency})</legend>
        <p className="muted small">Leave blank if not configured. No default limits are assumed.</p>
        <div className="grid2">
          <Field label="Max risk per trade">{(id) => <NumberInput id={id} value={f.riskSettings.maxRiskPerTrade} onChange={(v) => setRisk('maxRiskPerTrade', v)} min={0} />}</Field>
          <Field label="Daily loss limit">{(id) => <NumberInput id={id} value={f.riskSettings.dailyLossLimit} onChange={(v) => setRisk('dailyLossLimit', v)} min={0} />}</Field>
          <Field label="Max total drawdown">{(id) => <NumberInput id={id} value={f.riskSettings.maxTotalDrawdown} onChange={(v) => setRisk('maxTotalDrawdown', v)} min={0} />}</Field>
          <Field label="Max aggregate open+pending risk">{(id) => <NumberInput id={id} value={f.riskSettings.maxAggregateRisk} onChange={(v) => setRisk('maxAggregateRisk', v)} min={0} />}</Field>
          <Field label="Max volume (lots)">{(id) => <NumberInput id={id} value={f.riskSettings.maxVolume} onChange={(v) => setRisk('maxVolume', v)} min={0} />}</Field>
          <Field label="Snapshot max age (minutes)">{(id) => <NumberInput id={id} value={f.riskSettings.maxSnapshotAgeMinutes} onChange={(v) => setRisk('maxSnapshotAgeMinutes', v ?? 60)} min={1} />}</Field>
        </div>
      </fieldset>
      <Field label="Notes">{(id) => <textarea id={id} rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />}</Field>
      <p className="muted small">Trade Command never asks for or stores MT5 passwords.</p>
      <div className="row">
        <button type="submit" className="btn btn-primary">
          Save account
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SnapshotForm({ account, onDone }: { account: TradingAccount; onDone: () => void }) {
  const store = useStoreInstance();
  const run = useAction();
  const s = account.snapshot;
  const [balance, setBalance] = useState<number | undefined>(s?.balance);
  const [equity, setEquity] = useState<number | undefined>(s?.equity);
  const [dailyLossUsed, setDaily] = useState<number | undefined>(s?.dailyLossUsed ?? 0);
  const [ref, setRef] = useState<number | undefined>(s?.drawdownReference ?? account.accountSize);
  const [fx, setFx] = useState<number | undefined>(account.fxRates?.USD?.rate);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (balance === undefined || equity === undefined || ref === undefined) return;
        run(() => store.setSnapshot(account.id, { balance, equity, dailyLossUsed: dailyLossUsed ?? 0, drawdownReference: ref }));
        if (account.currency !== 'USD' && fx) run(() => store.setFxRate(account.id, 'USD', fx));
        onDone();
      }}
    >
      <p className="muted small">Manual entry from your broker/firm dashboard. Timestamped now; becomes stale after {account.riskSettings.maxSnapshotAgeMinutes} min.</p>
      <div className="grid2">
        <Field label="Balance">{(id) => <NumberInput id={id} value={balance} onChange={setBalance} required />}</Field>
        <Field label="Equity">{(id) => <NumberInput id={id} value={equity} onChange={setEquity} required />}</Field>
        <Field label="Loss already used today">{(id) => <NumberInput id={id} value={dailyLossUsed} onChange={setDaily} min={0} />}</Field>
        <Field label="Drawdown reference balance">{(id) => <NumberInput id={id} value={ref} onChange={setRef} min={0} required />}</Field>
        {account.currency !== 'USD' && (
          <Field label={`USD→${account.currency} rate`} hint="Needed when the instrument profit currency differs.">
            {(id) => <NumberInput id={id} value={fx} onChange={setFx} min={0} />}
          </Field>
        )}
      </div>
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Save snapshot
        </button>
        <button className="btn" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Accounts() {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [snap, setSnap] = useState<string | null>(null);

  const filtered = data.accounts.filter((a) => `${a.displayName} ${a.firm} ${a.program}`.toLowerCase().includes(q.toLowerCase()));
  const server = (id?: string) => data.servers.find((s) => s.id === id);
  const groupsOf = (id: string) => data.groups.filter((g) => g.accountIds.includes(id)).map((g) => g.name);

  return (
    <>
      <PageHeader
        title="Trading accounts"
        subtitle={`${data.accounts.length} of ${MAX_ACCOUNTS} configured`}
        actions={
          <button className="btn btn-primary" disabled={data.accounts.length >= MAX_ACCOUNTS || editing !== null} onClick={() => setEditing('new')}>
            Add account
          </button>
        }
      />
      {editing === 'new' && (
        <Card title="New account">
          <AccountForm
            initial={blank()}
            onCancel={() => setEditing(null)}
            onSave={(a) => {
              if (run(() => store.addAccount(a))) setEditing(null);
            }}
          />
        </Card>
      )}
      {data.accounts.length > 0 && (
        <input className="search" type="search" placeholder="Search accounts" aria-label="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      {data.accounts.length === 0 && editing === null && <EmptyState title="No accounts">Add up to {MAX_ACCOUNTS} of your own trading accounts.</EmptyState>}
      <div className="list">
        {filtered.map((a) => {
          const [connLabel, connTone] = CONNECTION[a.connectionStatus];
          if (editing === a.id) {
            return (
              <Card key={a.id} title={`Edit ${a.displayName}`}>
                <AccountForm
                  initial={a}
                  onCancel={() => setEditing(null)}
                  onSave={(next) => {
                    run(() => store.updateAccount(a.id, next));
                    setEditing(null);
                  }}
                />
              </Card>
            );
          }
          return (
            <Card
              key={a.id}
              title={a.displayName}
              actions={
                <>
                  <button className="btn btn-sm" onClick={() => setEditing(a.id)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => ask('Remove account?', <p>Remove “{a.displayName}”? It will also be removed from its groups.</p>, () => run(() => store.removeAccount(a.id)), { label: 'Remove', danger: true })}
                  >
                    Remove
                  </button>
                </>
              }
            >
              <div className="chips">
                <Badge tone={a.tradingEnabled ? 'ok' : 'neutral'}>{a.tradingEnabled ? 'Trading enabled' : 'Trading disabled'}</Badge>
                <Badge tone={connTone}>{connLabel}</Badge>
                <Badge tone={a.executionMode === 'simulation' ? 'sim' : 'neutral'}>{EXEC_MODE[a.executionMode].split(' (')[0]}</Badge>
                {!a.compatibilityProfileId && <Badge tone="warn">Rules unverified</Badge>}
              </div>
              <dl className="kv">
                <dt>Firm / program</dt>
                <dd>
                  {a.firm} {a.program && `· ${a.program}`}
                </dd>
                <dt>Platform / server</dt>
                <dd>
                  {a.platform} · {server(a.serverId)?.serverName ?? 'no server'}
                </dd>
                <dt>Size</dt>
                <dd>
                  {a.accountSize.toLocaleString()} {a.currency}
                </dd>
                <dt>Instruments</dt>
                <dd>{a.instrumentPermissions.join(', ') || 'none'}</dd>
                <dt>Groups</dt>
                <dd>{groupsOf(a.id).join(', ') || '—'}</dd>
                <dt>Max risk / trade</dt>
                <dd>{a.riskSettings.maxRiskPerTrade !== undefined ? `${a.riskSettings.maxRiskPerTrade} ${a.currency}` : <Badge tone="warn">Not set</Badge>}</dd>
                <dt>Snapshot</dt>
                <dd>{a.snapshot ? `Eq ${a.snapshot.equity.toLocaleString()} · ${a.snapshot.source.replace('_', ' ')} · ${fmtTime(a.snapshot.asOf)}` : 'none'}</dd>
              </dl>
              {snap === a.id ? (
                <SnapshotForm account={a} onDone={() => setSnap(null)} />
              ) : (
                <button className="btn btn-sm" onClick={() => setSnap(a.id)}>
                  Enter balance/equity snapshot
                </button>
              )}
            </Card>
          );
        })}
      </div>
      {dialog}
    </>
  );
}
