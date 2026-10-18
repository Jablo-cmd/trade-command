import { useState } from 'react';
import { COMPATIBILITY_LABELS, compatibilitySummary, evaluateExecutionMode } from '../../domain/compatibility';
import { COMPATIBILITY_ITEMS, type CompatibilityItem, type CompatibilityItemKey, type CompatibilityProfile, type RuleStatus } from '../../domain/types';
import { Badge, Card, EmptyState, Field, List, PageHeader, useConfirm } from '../components';
import { RULE } from '../labels';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

function ItemEditor({ profile, k }: { profile: CompatibilityProfile; k: CompatibilityItemKey }) {
  const store = useStoreInstance();
  const run = useAction();
  const item = profile.items[k];
  const [f, setF] = useState<CompatibilityItem>(item);
  const [open, setOpen] = useState(false);
  const [label, tone] = RULE[item.status];
  return (
    <div className="compat-item">
      <button type="button" className="compat-head" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
        <span>{COMPATIBILITY_LABELS[k]}</span>
        <Badge tone={tone}>{label}</Badge>
      </button>
      {item.source && !open && (
        <div className="muted small">
          {item.source} · {item.verifiedOn}
        </div>
      )}
      {open && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => {
              store.updateProfileItem(profile.id, k, f);
              setOpen(false);
            });
          }}
        >
          <div className="grid2">
            <Field label="Status">
              {(id) => (
                <select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as RuleStatus })}>
                  <option value="unknown">Unknown</option>
                  <option value="permitted">Permitted</option>
                  <option value="conditional">Conditional</option>
                  <option value="prohibited">Prohibited</option>
                </select>
              )}
            </Field>
            <Field label="Source (required unless unknown/prohibited)">{(id) => <input id={id} value={f.source ?? ''} onChange={(e) => setF({ ...f, source: e.target.value || undefined })} />}</Field>
            <Field label="Verified on">{(id) => <input id={id} type="date" value={f.verifiedOn ?? ''} onChange={(e) => setF({ ...f, verifiedOn: e.target.value || undefined })} />}</Field>
            <Field label="Notes / conditions">{(id) => <input id={id} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value || undefined })} />}</Field>
          </div>
          <div className="row">
            <button className="btn btn-primary btn-sm" type="submit">
              Save
            </button>
            <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function Compatibility() {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [firm, setFirm] = useState('');
  const [program, setProgram] = useState('');
  return (
    <>
      <PageHeader title="Prop-firm compatibility" subtitle="Record each firm/program’s rules with a source and date. Unknown rules block live execution." />
      <Card title="New profile">
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (run(() => store.addProfile(firm, program))) {
              setFirm('');
              setProgram('');
            }
          }}
        >
          <input aria-label="Firm" placeholder="Firm" value={firm} onChange={(e) => setFirm(e.target.value)} required />
          <input aria-label="Program" placeholder="Program / account type" value={program} onChange={(e) => setProgram(e.target.value)} required />
          <button className="btn btn-primary" type="submit">
            Add profile
          </button>
        </form>
      </Card>
      {data.profiles.length === 0 && <EmptyState title="No compatibility profiles">Accounts without a profile are treated as unverified.</EmptyState>}
      <div className="list">
        {data.profiles.map((p) => {
          const s = compatibilitySummary(p);
          const live = evaluateExecutionMode(p, 'live_automated');
          const accounts = data.accounts.filter((a) => a.compatibilityProfileId === p.id);
          return (
            <Card
              key={p.id}
              title={`${p.firm} / ${p.program}`}
              actions={
                <button className="btn btn-sm btn-danger-ghost" onClick={() => ask('Delete profile?', <p>Accounts linked to it will become unverified.</p>, () => run(() => store.removeProfile(p.id)), { label: 'Delete', danger: true })}>
                  Delete
                </button>
              }
            >
              <div className="chips">
                <Badge tone="ok">{s.permitted} permitted</Badge>
                <Badge tone="warn">{s.conditional} conditional</Badge>
                <Badge tone="bad">{s.prohibited} prohibited</Badge>
                <Badge>{s.unknown} unknown</Badge>
                <Badge tone={live.allowed ? 'ok' : 'bad'}>Live automation: {live.allowed ? 'rules verified' : 'blocked'}</Badge>
              </div>
              <p className="small muted">Linked accounts: {accounts.map((a) => a.displayName).join(', ') || 'none'}</p>
              {!live.allowed && (
                <details>
                  <summary className="small">Why live automation is blocked ({live.blockers.length})</summary>
                  <List items={live.blockers} />
                </details>
              )}
              {COMPATIBILITY_ITEMS.map((k) => (
                <ItemEditor key={k} profile={p} k={k} />
              ))}
            </Card>
          );
        })}
      </div>
      <p className="muted small">
        Trade Command never claims a firm permits a method. It does not implement randomisation, jitter or any technique to disguise copying or evade firm detection.
      </p>
      {dialog}
    </>
  );
}
