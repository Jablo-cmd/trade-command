import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function isSupabaseConfigured(): boolean {
  return !!url && !!anonKey;
}

let client: SupabaseClient | undefined;

/** Browser client using the publishable (anon) key only. RLS protects every table. */
export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) throw new Error('Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).');
  client ??= createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}
