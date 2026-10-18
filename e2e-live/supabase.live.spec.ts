import { expect, test, type Browser, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL ?? '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? '';
const run = Date.now().toString(36);
const password = `Tc-live-${run}-pw!`;
const userA = `tc-live-${run}-a@example.com`;
const userB = `tc-live-${run}-b@example.com`;
const tag = `LIVE-${run}`;

test.skip(!url || !anonKey, 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set');
test.describe.configure({ mode: 'serial' });

async function signUp(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  // With "Confirm email" off, sign-up returns a session and the app opens directly.
  await expect(page.getByText('SIMULATION', { exact: true })).toBeVisible({ timeout: 20_000 });
  return page;
}

async function noSyncError(page: Page) {
  await page.waitForTimeout(2_000);
  await expect(page.locator('.error-banner')).toHaveCount(0);
}

async function apiClient(email: string) {
  const c = createClient(url, anonKey, { auth: { persistSession: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { c, userId: data.user.id };
}

test('user A: data created in the app is saved to Supabase and survives reload', async ({ browser }) => {
  const page = await signUp(browser, userA);

  await page.goto('/#/servers');
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByLabel('Firm').fill(`Firm ${tag}`);
  await page.getByLabel('Server name').fill(`Srv-${tag}`);
  await page.getByRole('button', { name: 'Save server' }).click();
  await expect(page.getByRole('heading', { name: `Srv-${tag}` })).toBeVisible();
  await noSyncError(page);

  await page.goto('/#/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByLabel('Display name').fill(`Acct ${tag}`);
  await page.getByLabel('Prop firm').fill(`Firm ${tag}`);
  await page.getByLabel('Server', { exact: true }).selectOption({ label: `Srv-${tag} (Firm ${tag})` });
  await page.getByLabel('Max risk per trade').fill('250');
  await page.getByRole('button', { name: 'Save account' }).click();
  await expect(page.getByRole('heading', { name: `Acct ${tag}` })).toBeVisible();
  await noSyncError(page);

  await page.goto('/#/groups');
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('Group name').fill(`Group ${tag}`);
  await page.getByRole('checkbox', { name: new RegExp(`Acct ${tag}`) }).check();
  await page.getByRole('button', { name: 'Save group' }).click();
  await expect(page.getByText(`Group ${tag}`).first()).toBeVisible();
  await noSyncError(page);

  // Wipe the browser cache and reload: everything must come back from the database.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('trade-command')) localStorage.removeItem(k);
  });
  await page.reload();
  await page.goto('/#/accounts');
  await expect(page.getByRole('heading', { name: `Acct ${tag}` })).toBeVisible({ timeout: 20_000 });
  await page.goto('/#/servers');
  await expect(page.getByRole('heading', { name: `Srv-${tag}` })).toBeVisible();
  await page.goto('/#/groups');
  await expect(page.getByText(`Group ${tag}`).first()).toBeVisible();
  await expect(page.locator('.error-banner')).toHaveCount(0);

  // Same rows through the API with A's own token.
  const { c, userId } = await apiClient(userA);
  const accts = await c.from('trading_accounts').select('id,user_id,display_name');
  expect(accts.error).toBeNull();
  expect(accts.data).toEqual([expect.objectContaining({ user_id: userId, display_name: `Acct ${tag}` })]);
  const members = await c.from('group_memberships').select('*');
  expect(members.data?.length).toBe(1);
  const audit = await c.from('audit_events').select('id');
  expect(audit.data?.length ?? 0).toBeGreaterThan(0);
});

test('user B: cannot see, change or claim user A’s data', async ({ browser }) => {
  const page = await signUp(browser, userB);
  await page.goto('/#/accounts');
  await expect(page.getByText(`Acct ${tag}`)).toHaveCount(0);
  await page.goto('/#/servers');
  await expect(page.getByText(`Srv-${tag}`)).toHaveCount(0);
  await page.goto('/#/groups');
  await expect(page.getByText(`Group ${tag}`)).toHaveCount(0);
  await expect(page.locator('.error-banner')).toHaveCount(0);

  const a = await apiClient(userA);
  const aAcct = (await a.c.from('trading_accounts').select('id').single()).data!;
  const b = await apiClient(userB);

  for (const t of ['trading_accounts', 'server_directory_entries', 'account_groups', 'group_memberships', 'audit_events', 'profiles']) {
    const r = await b.c.from(t).select('*').eq(t === 'profiles' ? 'id' : 'user_id', a.userId);
    expect(r.error, t).toBeNull();
    expect(r.data, t).toEqual([]);
  }
  const upd = await b.c.from('trading_accounts').update({ display_name: 'hijacked' }).eq('id', aAcct.id).select();
  expect(upd.data ?? []).toEqual([]);
  const del = await b.c.from('trading_accounts').delete().eq('id', aAcct.id).select();
  expect(del.data ?? []).toEqual([]);
  const ins = await b.c.from('account_groups').insert({ user_id: a.userId, name: 'spoof', sort_order: 0 });
  expect(ins.error).not.toBeNull();
  // Execution records are read-only for clients, even for one's own user id.
  const ord = await b.c.from('orders').insert({ user_id: b.userId });
  expect(ord.error).not.toBeNull();
  // Anonymous (no session) sees nothing.
  const anon = createClient(url, anonKey, { auth: { persistSession: false } });
  const ar = await anon.from('trading_accounts').select('id');
  expect(ar.data ?? []).toEqual([]);

  // A's data is untouched.
  const still = await a.c.from('trading_accounts').select('display_name').single();
  expect(still.data?.display_name).toBe(`Acct ${tag}`);
});
