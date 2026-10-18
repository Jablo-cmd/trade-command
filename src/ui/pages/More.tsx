import { PageHeader } from '../components';
import { ROUTES, type Route } from '../router';

export function More({ go }: { go: (r: Route) => void }) {
  return (
    <>
      <PageHeader title="All sections" />
      <nav aria-label="All sections" className="menu">
        {ROUTES.map((r) => (
          <button key={r.id} className="menu-item" onClick={() => go(r.id)}>
            {r.label}
            <span aria-hidden>›</span>
          </button>
        ))}
      </nav>
    </>
  );
}
