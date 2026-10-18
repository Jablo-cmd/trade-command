import { useState } from 'react';
import type { InstrumentSpec, Platform, ServerDirectoryEntry, VerificationInfo, VerificationStatus } from '../../domain/types';
import type { SpecInput } from '../../state/store';
import { Badge, Card, EmptyState, Field, NumberInput, PageHeader, fmtTime, useConfirm } from '../components';
import { VERIFICATION } from '../labels';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

function VerificationFields({ value, onChange }: { value: VerificationInfo; onChange: (v: VerificationInfo) => void }) {
  return (
    <div className="grid2">
      <Field label="Verification">
        {(id) => (
          <select id={id} value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as VerificationStatus })}>
            <option value="user_supplied">User-supplied (unverified)</option>
            <option value="verified">Verified against a source</option>
            <option value="unknown">Unknown</option>
          </select>
        )}
      </Field>
      <Field label="Source" hint="URL, document or support reference">
        {(id) => <input id={id} value={value.source ?? ''} onChange={(e) => onChange({ ...value, source: e.target.value || undefined })} />}
      </Field>
      <Field label="Verified on">{(id) => <input id={id} type="date" value={value.verifiedOn ?? ''} onChange={(e) => onChange({ ...value, verifiedOn: e.target.value || undefined })} />}</Field>
    </div>
  );
}

type ServerForm = { firm: string; serverName: string; platform: Platform; verification: VerificationInfo; notes?: string };

function ServerEditor({ initial, onSave, onCancel }: { initial: ServerForm; onSave: (s: ServerForm) => void; onCancel: () => void }) {
  const [f, setF] = useState(initial);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <div className="grid2">
        <Field label="Firm">{(id) => <input id={id} required value={f.firm} onChange={(e) => setF({ ...f, firm: e.target.value })} />}</Field>
        <Field label="Server name" hint="Type it exactly as shown in your MT5 login dialog.">
          {(id) => <input id={id} required value={f.serverName} onChange={(e) => setF({ ...f, serverName: e.target.value })} />}
        </Field>
        <Field label="Platform">
          {(id) => (
            <select id={id} value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value as Platform })}>
              {['MT5', 'MT4', 'cTrader', 'DXtrade', 'MatchTrader', 'other'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <VerificationFields value={f.verification} onChange={(verification) => setF({ ...f, verification })} />
      <Field label="Notes">{(id) => <input id={id} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Save server
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SpecEditor({ serverId, initial, onDone }: { serverId: string; initial?: InstrumentSpec; onDone: () => void }) {
  const store = useStoreInstance();
  const run = useAction();
  const [f, setF] = useState<SpecInput & { id?: string }>(
    initial ?? {
      serverId,
      symbol: 'XAUUSD',
      tickSize: undefined as unknown as number,
      tickValue: undefined as unknown as number,
      contractSize: undefined as unknown as number,
      profitCurrency: 'USD',
      volumeMin: undefined as unknown as number,
      volumeMax: undefined as unknown as number,
      volumeStep: undefined as unknown as number,
      minStopDistance: 0,
      verification: { status: 'user_supplied' },
    },
  );
  const num = (k: keyof SpecInput) => (v: number | undefined) => setF((p) => ({ ...p, [k]: v as number }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => {
          store.upsertSpec(f);
          onDone();
        });
      }}
    >
      <p className="muted small">Copy these from the MT5 symbol specification window for this server. Do not assume another broker&apos;s values.</p>
      <div className="grid3">
        <Field label="Symbol">{(id) => <input id={id} required value={f.symbol} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Tick size">{(id) => <NumberInput id={id} value={f.tickSize} onChange={num('tickSize')} required />}</Field>
        <Field label="Tick value (1 lot)">{(id) => <NumberInput id={id} value={f.tickValue} onChange={num('tickValue')} required />}</Field>
        <Field label="Contract size">{(id) => <NumberInput id={id} value={f.contractSize} onChange={num('contractSize')} required />}</Field>
        <Field label="Profit currency">{(id) => <input id={id} maxLength={3} required value={f.profitCurrency} onChange={(e) => setF({ ...f, profitCurrency: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Min volume">{(id) => <NumberInput id={id} value={f.volumeMin} onChange={num('volumeMin')} required />}</Field>
        <Field label="Max volume">{(id) => <NumberInput id={id} value={f.volumeMax} onChange={num('volumeMax')} required />}</Field>
        <Field label="Volume step">{(id) => <NumberInput id={id} value={f.volumeStep} onChange={num('volumeStep')} required />}</Field>
        <Field label="Min stop distance">{(id) => <NumberInput id={id} value={f.minStopDistance} onChange={num('minStopDistance')} required />}</Field>
        <Field label="Commission / lot (acct ccy)">{(id) => <NumberInput id={id} value={f.commissionPerLot} onChange={num('commissionPerLot')} />}</Field>
      </div>
      <VerificationFields value={f.verification} onChange={(verification) => setF({ ...f, verification })} />
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Save specification
        </button>
        <button className="btn" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ServerCard({ s }: { s: ServerDirectoryEntry }) {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [edit, setEdit] = useState(false);
  const [specEdit, setSpecEdit] = useState<string | 'new' | null>(null);
  const [label, tone] = VERIFICATION[s.verification.status];
  const specs = data.specs.filter((x) => x.serverId === s.id);
  const used = data.accounts.filter((a) => a.serverId === s.id).length;

  if (edit) {
    return (
      <Card title={`Edit ${s.serverName}`}>
        <ServerEditor
          initial={s}
          onCancel={() => setEdit(false)}
          onSave={(f) => {
            run(() => store.updateServer(s.id, f));
            setEdit(false);
          }}
        />
      </Card>
    );
  }
  return (
    <Card
      title={s.serverName}
      actions={
        <>
          <button className="btn btn-sm" onClick={() => setEdit(true)}>
            Edit
          </button>
          <button className="btn btn-sm btn-danger-ghost" onClick={() => ask('Remove server entry?', <p>Remove “{s.serverName}” and its instrument specifications?</p>, () => run(() => store.removeServer(s.id)), { label: 'Remove', danger: true })}>
            Remove
          </button>
        </>
      }
    >
      <div className="chips">
        <Badge tone={tone}>{label}</Badge>
        <Badge>{s.origin === 'custom' ? 'Custom entry' : 'Directory'}</Badge>
        <Badge>{s.platform}</Badge>
        <Badge tone="neutral">Not a connection</Badge>
      </div>
      <dl className="kv">
        <dt>Firm</dt>
        <dd>{s.firm}</dd>
        <dt>Source</dt>
        <dd>{s.verification.source ?? '—'}</dd>
        <dt>Verified on</dt>
        <dd>{s.verification.verifiedOn ?? '—'}</dd>
        <dt>Used by</dt>
        <dd>{used} account(s)</dd>
        <dt>Updated</dt>
        <dd>{fmtTime(s.updatedAt)}</dd>
      </dl>
      <h3>Instrument specifications</h3>
      {specs.length === 0 && <p className="muted small">None. Risk sizing is blocked for accounts on this server until a spec is entered.</p>}
      {specs.map((sp) =>
        specEdit === sp.id ? (
          <SpecEditor key={sp.id} serverId={s.id} initial={sp} onDone={() => setSpecEdit(null)} />
        ) : (
          <div key={sp.id} className="spec-row">
            <div>
              <strong>{sp.symbol}</strong> <Badge tone={VERIFICATION[sp.verification.status][1]}>{VERIFICATION[sp.verification.status][0]}</Badge>
              <div className="muted small">
                tick {sp.tickSize} = {sp.tickValue} {sp.profitCurrency}/lot · vol {sp.volumeMin}–{sp.volumeMax} step {sp.volumeStep} · min stop {sp.minStopDistance}
              </div>
            </div>
            <div className="row">
              <button className="btn btn-sm" onClick={() => setSpecEdit(sp.id)}>
                Edit
              </button>
              <button className="btn btn-sm btn-danger-ghost" onClick={() => run(() => store.removeSpec(sp.id))}>
                Remove
              </button>
            </div>
          </div>
        ),
      )}
      {specEdit === 'new' ? (
        <SpecEditor serverId={s.id} onDone={() => setSpecEdit(null)} />
      ) : (
        <button className="btn btn-sm" onClick={() => setSpecEdit('new')}>
          Add instrument spec
        </button>
      )}
      {dialog}
    </Card>
  );
}

export function Servers() {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [onlyVerified, setOnlyVerified] = useState(false);

  const filtered = data.servers
    .filter((s) => `${s.firm} ${s.serverName}`.toLowerCase().includes(q.toLowerCase()))
    .filter((s) => !onlyVerified || s.verification.status === 'verified')
    .sort((a, b) => a.firm.localeCompare(b.firm) || a.serverName.localeCompare(b.serverName));

  const importDirectory = (file: File) => {
    void file.text().then((text) =>
      run(() => {
        const rows = JSON.parse(text) as Partial<ServerDirectoryEntry & { source: string; verifiedOn: string }>[];
        if (!Array.isArray(rows)) throw new Error('Expected an array');
        for (const r of rows) {
          if (!r.firm || !r.serverName) continue;
          const verified = !!r.source && !!r.verifiedOn;
          store.addServer({
            firm: r.firm,
            serverName: r.serverName,
            platform: (r.platform as Platform) ?? 'MT5',
            origin: 'directory',
            verification: { status: verified ? 'verified' : 'user_supplied', source: r.source, verifiedOn: r.verifiedOn },
            notes: r.notes,
          });
        }
      }),
    );
  };

  return (
    <>
      <PageHeader
        title="MT5 servers"
        subtitle="Directory of firm/server names. An entry is reference data — it is not proof of a connection."
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={adding}>
            Add server
          </button>
        }
      />
      {adding && (
        <Card title="New server entry">
          <ServerEditor
            initial={{ firm: '', serverName: '', platform: 'MT5', verification: { status: 'user_supplied' } }}
            onCancel={() => setAdding(false)}
            onSave={(f) => {
              if (run(() => store.addServer({ ...f, origin: 'custom' }))) setAdding(false);
            }}
          />
        </Card>
      )}
      <div className="row wrap">
        <input className="search" type="search" placeholder="Search firm or server" aria-label="Search servers" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={onlyVerified} onChange={(e) => setOnlyVerified(e.target.checked)} />
          <span>Verified only</span>
        </label>
        <label className="btn btn-sm file-btn">
          Import directory JSON
          <input type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && importDirectory(e.target.files[0])} />
        </label>
      </div>
      <p className="muted small">
        The directory ships empty: Trade Command does not invent server names. Import a JSON array of {'{firm, serverName, platform, source, verifiedOn}'}; entries without a source and date are marked unverified.
      </p>
      {data.servers.length === 0 && !adding && <EmptyState title="No servers yet">Add the server names shown in your MT5 login dialogs.</EmptyState>}
      {data.servers.length > 0 && filtered.length === 0 && <EmptyState title="No matches" />}
      <div className="list">
        {filtered.map((s) => (
          <ServerCard key={s.id} s={s} />
        ))}
      </div>
    </>
  );
}
