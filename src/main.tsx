import { StrictMode, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { AuthGate } from './ui/AuthGate';
import { StoreContext } from './ui/storeContext';
import { ConnectorProvider, supabaseConnectorDb } from './execution/connectorProvider';
import { LocalRepository } from './state/repository';
import { Store } from './state/store';
import { getSupabase, isSupabaseConfigured } from './state/supabaseConfig';
import { SupabaseRepository } from './state/supabaseRepository';
import './styles.css';

function WithStore({ userId }: { userId?: string }) {
  const store = useMemo(() => {
    if (!userId) return new Store(new LocalRepository());
    const repo = new SupabaseRepository(getSupabase(), userId);
    const s = new Store(repo, { connector: new ConnectorProvider(supabaseConnectorDb(getSupabase())) });
    repo.onError = s.reportError;
    return s;
  }, [userId]);
  useEffect(() => {
    store.init().catch((e: unknown) => store.reportError(`Failed to load data: ${String(e)}`));
  }, [store]);
  return (
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isSupabaseConfigured() ? <AuthGate>{(session) => <WithStore userId={session.user.id} />}</AuthGate> : <WithStore />}</StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('SW registration failed', e));
  });
}
