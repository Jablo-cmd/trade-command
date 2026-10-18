import { useState } from 'react';
import type { AuditCategory } from '../../domain/types';
import { Badge, EmptyState, PageHeader, fmtTime } from '../components';
import { useAppState } from '../storeContext';

const CATS: (AuditCategory | 'all')[] = ['all', 'signal', 'order', 'execution', 'safety', 'account', 'group', 'server', 'risk', 'compatibility', 'settings'];

export function Audit() {
  const { data } = useAppState();
  const [cat, setCat] = useState<AuditCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const rows = data.audit.filter((e) => (cat === 'all' || e.category === cat) && e.message.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title="Audit history" subtitle={`${data.audit.length} events, newest first. Credentials are never logged.`} />
      <div className="row wrap">
        <select aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value as AuditCategory | 'all')}>
          {CATS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input className="search" type="search" placeholder="Search events" aria-label="Search events" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No events" />
      ) : (
        <ul className="timeline audit">
          {rows.slice(0, 300).map((e) => (
            <li key={e.id}>
              <div className="row">
                <Badge tone={e.category === 'safety' ? 'bad' : 'neutral'}>{e.category}</Badge>
                {e.simulated && <Badge tone="sim">SIM</Badge>}
                <span className="muted small">{fmtTime(e.at)}</span>
              </div>
              <div>{e.message}</div>
              {e.details && (
                <details>
                  <summary className="small">Details</summary>
                  <pre className="small">{JSON.stringify(e.details, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
