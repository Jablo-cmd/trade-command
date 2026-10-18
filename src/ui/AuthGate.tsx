import { useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabase } from '../state/supabaseConfig';

/** Requires a Supabase session when Supabase is configured. Uses the anon key + RLS only. */
export function AuthGate({ children }: { children: (session: Session) => ReactNode }) {
  const sb = getSupabase();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, [sb]);

  if (session === undefined) return <div className="loading">Checking session…</div>;
  if (session) return <>{children(session)}</>;

  const submit = async (mode: 'in' | 'up') => {
    setBusy(true);
    setMsg(undefined);
    const { error } = mode === 'in' ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password });
    setBusy(false);
    if (error) setMsg(error.message);
    else if (mode === 'up') setMsg('Check your email to confirm the account, then sign in.');
  };

  return (
    <main className="auth">
      <h1>Trade Command</h1>
      <p className="muted">Sign in to your private workspace.</p>
      <form
        className="form card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit('in');
        }}
      >
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        {msg && <p role="alert" className="small">{msg}</p>}
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Sign in
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void submit('up')}>
            Create account
          </button>
        </div>
      </form>
    </main>
  );
}
