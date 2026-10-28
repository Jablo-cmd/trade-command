import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { ROUTES, useRoute, type Route } from './router';
import { useAppState, useStoreInstance } from './storeContext';
import { Dashboard } from './pages/Dashboard';
import { Accounts } from './pages/Accounts';
import { Servers } from './pages/Servers';
import { Groups } from './pages/Groups';
import { Staging } from './pages/Staging';
import { SignalPage } from './pages/Signal';
import { Orders } from './pages/Orders';
import { Risk } from './pages/Risk';
import { Compatibility } from './pages/Compatibility';
import { Audit } from './pages/Audit';
import { Settings } from './pages/Settings';
import { More } from './pages/More';

const NAV: { id: Route; label: string; icon: ReactNode }[] = [
  { id: 'dashboard', label: 'Home', icon: <path d="M3 11l9-8 9 8v10h-6v-6H9v6H3z" /> },
  { id: 'accounts', label: 'Accounts', icon: <path d="M4 5h16v14H4zM4 9h16M8 14h4" /> },
  { id: 'signal', label: 'Signal', icon: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" /> },
  { id: 'orders', label: 'Orders', icon: <path d="M6 4h12v16H6zM9 8h6M9 12h6M9 16h3" /> },
  { id: 'more', label: 'More', icon: <path d="M5 12h.01M12 12h.01M19 12h.01" /> },
];

function ModeBanner() {
  const { data } = useAppState();
  const store = useStoreInstance();
  if (data.settings.emergencyDisabled) {
    return (
      <div className="banner banner-bad" role="alert">
        <strong>EMERGENCY DISABLE ACTIVE</strong> — new submissions are blocked.
      </div>
    );
  }
  if (store.provider.info.simulated) {
    return (
      <div className="banner banner-sim" role="status">
        <strong>SIMULATION</strong> — no broker is connected; no real orders are placed.
      </div>
    );
  }
  if (store.provider.info.serverValidated) {
    return (
      <div className="banner banner-bad" role="status">
        <strong>LIVE MT5</strong> — authorised orders go to MT5 through your VPS connector.
      </div>
    );
  }
  return (
    <div className="banner banner-warn" role="status">
      <strong>MT5 UNAVAILABLE</strong> — no connector installed; execution is blocked.
    </div>
  );
}

export function App() {
  const state = useAppState();
  const store = useStoreInstance();
  const [route, go] = useRoute();

  if (!state.ready) {
    return (
      <div className="loading" role="status" aria-live="polite">
        Loading Trade Command…
      </div>
    );
  }

  const page = (() => {
    switch (route) {
      case 'dashboard':
        return <Dashboard go={go} />;
      case 'accounts':
        return <Accounts />;
      case 'servers':
        return <Servers />;
      case 'groups':
        return <Groups />;
      case 'staging':
        return <Staging go={go} />;
      case 'signal':
        return <SignalPage go={go} />;
      case 'orders':
        return <Orders />;
      case 'risk':
        return <Risk />;
      case 'compatibility':
        return <Compatibility />;
      case 'audit':
        return <Audit />;
      case 'settings':
        return <Settings />;
      case 'more':
        return <More go={go} />;
    }
  })();

  const title = ROUTES.find((r) => r.id === route)?.label ?? 'More';
  const moreActive = !NAV.some((n) => n.id === route);

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/dashboard" className="brand" aria-label="Trade Command home">
          <LogoMark size={34} className="brand-mark" />
          <span className="wordmark">
            Trade <em>Command</em>
          </span>
        </a>
        <span className="topbar-title">{title}</span>
      </header>
      <ModeBanner />
      {state.error && (
        <div className="banner banner-bad error-banner" role="alert">
          <span>{state.error}</span>
          <button type="button" className="btn btn-sm" onClick={() => store.clearError()} aria-label="Dismiss error">
            Dismiss
          </button>
        </div>
      )}
      <main className="content" aria-busy={state.busy}>
        {page}
      </main>
      <nav className="bottom-nav" aria-label="Primary">
        {NAV.map((n) => {
          const active = n.id === route || (n.id === 'more' && moreActive);
          return (
            <a key={n.id} href={`#/${n.id}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {n.icon}
              </svg>
              <span>{n.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
