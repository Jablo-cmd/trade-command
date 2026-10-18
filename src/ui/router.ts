import { useEffect, useState } from 'react';

export type Route =
  | 'dashboard'
  | 'accounts'
  | 'servers'
  | 'groups'
  | 'staging'
  | 'signal'
  | 'orders'
  | 'risk'
  | 'compatibility'
  | 'audit'
  | 'settings'
  | 'more';

export const ROUTES: { id: Route; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'accounts', label: 'Trading accounts' },
  { id: 'servers', label: 'MT5 servers' },
  { id: 'groups', label: 'Account groups' },
  { id: 'signal', label: 'Master signal' },
  { id: 'staging', label: 'Staged entries' },
  { id: 'orders', label: 'Positions & orders' },
  { id: 'risk', label: 'Risk overview' },
  { id: 'compatibility', label: 'Prop-firm compatibility' },
  { id: 'audit', label: 'Audit history' },
  { id: 'settings', label: 'Settings' },
];

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES.some((r) => r.id === h) || h === 'more' ? h : 'dashboard') as Route;
}

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (window.location.hash = `/${r}`)];
}
