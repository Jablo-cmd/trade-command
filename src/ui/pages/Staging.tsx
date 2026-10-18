import { useState } from 'react';
import { buildGroupEntryPlans, validateOffsets } from '../../domain/staging';
import { computeDefaultTakeProfit, computeStopLoss } from '../../domain/strategy';
import type { Direction } from '../../domain/types';
import { Badge, Card, EmptyState, Field, List, NumberInput, PageHeader } from '../components';
import type { Route } from '../router';
import { useAction, useAppState, useStoreInstance } from '../storeContext';

export function Staging({ go }: { go: (r: Route) => void }) {
  const { data } = useAppState();
  const store = useStoreInstance();
  const run = useAction();
  const [ref, setRef] = useState<number | undefined>(4080);
  const [dir, setDir] = useState<Direction>('BUY');
  const groups = [...data.groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const strategy = data.settings.strategy;
  const v = validateOffsets(groups.filter((g) => g.enabled), 0.01);
  const plans = ref && ref > 0 && v.ok ? buildGroupEntryPlans(groups, ref, dir, 0.01) : [];

  return (
    <>
      <PageHeader title="Staged entries" subtitle="Configure each group’s offset and preview the ladder. Example prices are illustrative, not market data." />
      <Card title="Ladder preview (illustrative)">
        <div className="grid2">
          <Field label="Example reference price">{(id) => <NumberInput id={id} value={ref} onChange={setRef} min={0} />}</Field>
          <Field label="Direction">
            {(id) => (
              <select id={id} value={dir} onChange={(e) => setDir(e.target.value as Direction)}>
                <option>BUY</option>
                <option>SELL</option>
              </select>
            )}
          </Field>
        </div>
        <List items={[...v.errors, ...v.warnings]} />
        {groups.length === 0 ? (
          <EmptyState title="No groups" action={<button className="btn" onClick={() => go('groups')}>Create groups</button>} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Offset</th>
                <th>{dir} limit</th>
                <th>SL</th>
                <th>Default TP</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.groupId}>
                  <td>{p.groupName}</td>
                  <td>{p.entryOffset === 0 ? 'initial' : `${dir === 'BUY' ? '−' : '+'}${p.entryOffset}`}</td>
                  <td>{p.entryPrice.toFixed(2)}</td>
                  <td>{computeStopLoss(dir, p.entryPrice, strategy).toFixed(2)}</td>
                  <td>{computeDefaultTakeProfit(dir, p.entryPrice, strategy).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          SL/TP shown are computed from each level as if it filled exactly there. Live positions use the actual fill price. A pending limit is not a fill; price may reach TP without filling later groups.
        </p>
      </Card>

      <Card title="Group offsets">
        {groups.map((g) => (
          <div key={g.id} className="offset-row">
            <span>
              <strong>{g.name}</strong> {!g.enabled && <Badge>disabled</Badge>} <small className="muted">{g.accountIds.length} acct</small>
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              aria-label={`Offset for group ${g.name}`}
              defaultValue={g.entryOffset}
              onBlur={(e) => {
                const val = Number(e.target.value);
                if (val !== g.entryOffset) run(() => store.updateGroup(g.id, { entryOffset: val }));
              }}
            />
          </div>
        ))}
      </Card>
    </>
  );
}
