import { useState } from 'react';
import type { AccountGroup, StagingMode } from '../../domain/types';
import type { GroupInput } from '../../state/store';
import { Badge, Card, EmptyState, Field, NumberInput, PageHeader, Toggle, useConfirm } from '../components';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

function GroupEditor({ initial, onSave, onCancel }: { initial: GroupInput; onSave: (g: GroupInput) => void; onCancel: () => void }) {
  const { data } = useAppState();
  const [f, setF] = useState(initial);
  const toggleAcc = (id: string) => setF((p) => ({ ...p, accountIds: p.accountIds.includes(id) ? p.accountIds.filter((x) => x !== id) : [...p.accountIds, id] }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <div className="grid2">
        <Field label="Group name">{(id) => <input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Entry offset (price units)" hint="Below the reference for BUY, above it for SELL. 0 = at reference.">
          {(id) => <NumberInput id={id} value={f.entryOffset} onChange={(v) => setF({ ...f, entryOffset: v ?? 0 })} min={0} required />}
        </Field>
        <Field label="Staging mode">
          {(id) => (
            <select id={id} value={f.stagingMode} onChange={(e) => setF({ ...f, stagingMode: e.target.value as StagingMode })}>
              <option value="manual">Manual — submit this group yourself</option>
              <option value="automatic">Automatic — included in “submit all ready”</option>
            </select>
          )}
        </Field>
        <Field label="Group risk cap (optional)" hint="Max combined new risk across the group’s accounts.">
          {(id) => <NumberInput id={id} value={f.maxGroupRisk} onChange={(v) => setF({ ...f, maxGroupRisk: v })} min={0} />}
        </Field>
      </div>
      <Toggle label="Enabled" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
      <Toggle label="Require manual approval before execution" checked={f.requireApproval} onChange={(v) => setF({ ...f, requireApproval: v })} />
      <fieldset>
        <legend>
          Accounts ({f.accountIds.length} selected)
        </legend>
        {data.accounts.length === 0 && <p className="muted small">No accounts configured.</p>}
        <div className="checklist">
          {data.accounts.map((a) => (
            <label key={a.id} className="check">
              <input type="checkbox" checked={f.accountIds.includes(a.id)} onChange={() => toggleAcc(a.id)} />
              <span>
                {a.displayName} <small className="muted">{a.firm}</small>
                {!a.tradingEnabled && (
                  <>
                    {' '}
                    <Badge tone="neutral">disabled</Badge>
                  </>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" type="submit">
          Save group
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function Groups() {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const { dialog, ask } = useConfirm();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const groups = [...data.groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const accName = (id: string) => data.accounts.find((a) => a.id === id)?.displayName ?? '?';

  const card = (g: AccountGroup, i: number) =>
    editing === g.id ? (
      <Card key={g.id} title={`Edit group ${g.name}`}>
        <GroupEditor
          initial={g}
          onCancel={() => setEditing(null)}
          onSave={(f) => {
            run(() => store.updateGroup(g.id, f));
            setEditing(null);
          }}
        />
      </Card>
    ) : (
      <Card
        key={g.id}
        title={`Group ${g.name}`}
        actions={
          <>
            <button className="btn btn-sm" aria-label={`Move ${g.name} up`} disabled={i === 0} onClick={() => store.moveGroup(g.id, -1)}>
              ↑
            </button>
            <button className="btn btn-sm" aria-label={`Move ${g.name} down`} disabled={i === groups.length - 1} onClick={() => store.moveGroup(g.id, 1)}>
              ↓
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(g.id)}>
              Edit
            </button>
            <button className="btn btn-sm btn-danger-ghost" onClick={() => ask('Delete group?', <p>Delete group {g.name}? Accounts are not deleted.</p>, () => run(() => store.removeGroup(g.id)), { label: 'Delete', danger: true })}>
              Delete
            </button>
          </>
        }
      >
        <div className="chips">
          <Badge tone={g.enabled ? 'ok' : 'neutral'}>{g.enabled ? 'Enabled' : 'Disabled'}</Badge>
          <Badge>{g.stagingMode === 'automatic' ? 'Automatic' : 'Manual'}</Badge>
          <Badge tone="info">Offset {g.entryOffset}</Badge>
          {g.requireApproval && <Badge tone="warn">Approval required</Badge>}
          {g.maxGroupRisk !== undefined && <Badge>Cap {g.maxGroupRisk}</Badge>}
        </div>
        <p className="small">{g.accountIds.length ? g.accountIds.map(accName).join(', ') : <span className="muted">No accounts in this group.</span>}</p>
      </Card>
    );

  return (
    <>
      <PageHeader
        title="Account groups"
        subtitle="Groups of any size; each with its own entry offset, mode and approval."
        actions={
          <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={editing !== null}>
            New group
          </button>
        }
      />
      {editing === 'new' && (
        <Card title="New group">
          <GroupEditor
            initial={{ name: '', enabled: true, stagingMode: 'manual', entryOffset: 0, requireApproval: true, accountIds: [] }}
            onCancel={() => setEditing(null)}
            onSave={(f) => {
              if (run(() => store.addGroup(f))) setEditing(null);
            }}
          />
        </Card>
      )}
      {groups.length === 0 && editing === null && <EmptyState title="No groups">Create groups such as A–E and assign accounts to each.</EmptyState>}
      <div className="list">{groups.map(card)}</div>
      {dialog}
    </>
  );
}
