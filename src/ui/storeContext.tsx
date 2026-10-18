import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Store, StoreState } from '../state/store';

export const StoreContext = createContext<Store | null>(null);

export function useStoreInstance(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('StoreContext missing');
  return s;
}

export function useAppState(): StoreState {
  const s = useStoreInstance();
  return useSyncExternalStore(s.subscribe, s.getState, s.getState);
}

/** Run a store action; errors are surfaced via the store's error banner. */
export function useAction() {
  return <T,>(fn: () => T | Promise<T>) => {
    try {
      const r = fn();
      if (r instanceof Promise) return r.catch(() => undefined);
      return r;
    } catch {
      return undefined;
    }
  };
}
