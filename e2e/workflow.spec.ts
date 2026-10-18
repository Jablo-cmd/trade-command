import { expect, test, type Page } from '@playwright/test';

async function fresh(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/#/dashboard');
}

async function loadDemo(page: Page) {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'Load demo fixtures' }).click();
  await expect(page.getByText('Demo data can only')).toHaveCount(0);
}

async function setQuote(page: Page, bid: string, ask: string) {
  await page.goto('/#/orders');
  await page.getByLabel('Simulated bid').fill(bid);
  await page.getByLabel('Simulated ask').fill(ask);
  await page.getByRole('button', { name: 'Set simulated quote' }).click();
  await expect(page.getByText(`Current simulated XAUUSD quote: ${bid} / ${ask}`)).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => fresh(page));

test('dashboard shows simulation banner and empty state', async ({ page }) => {
  await expect(page.getByText('SIMULATION', { exact: true })).toBeVisible();
  await expect(page.getByText('no real orders are placed')).toBeVisible();
  await expect(page.getByText('No trading accounts yet')).toBeVisible();
  await expect(page.getByText('Accounts configured')).toBeVisible();
  await noHorizontalOverflow(page);
});

test('add a custom server and an account, then search', async ({ page }) => {
  await page.goto('/#/servers');
  await page.getByRole('button', { name: 'Add server' }).click();
  await page.getByLabel('Firm').fill('My Firm');
  await page.getByLabel('Server name').fill('MyFirm-Live-01');
  await page.getByRole('button', { name: 'Save server' }).click();
  await expect(page.getByRole('heading', { name: 'MyFirm-Live-01' })).toBeVisible();
  await expect(page.getByText('User-supplied · unverified')).toBeVisible();
  await expect(page.getByText('Not a connection')).toBeVisible();

  await page.goto('/#/accounts');
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByLabel('Display name').fill('Personal 1');
  await page.getByLabel('Prop firm').fill('My Firm');
  await page.getByLabel('Server', { exact: true }).selectOption({ label: 'MyFirm-Live-01 (My Firm)' });
  await page.getByLabel('Max risk per trade').fill('250');
  await page.getByRole('button', { name: 'Save account' }).click();
  await expect(page.getByRole('heading', { name: 'Personal 1' })).toBeVisible();
  await expect(page.getByText('1 of 40 configured')).toBeVisible();
  await page.getByLabel('Search accounts').fill('zzz');
  await expect(page.getByRole('heading', { name: 'Personal 1' })).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test('master signal → staged plan → simulated submission → fill → extended TP', async ({ page }) => {
  await loadDemo(page);
  await setQuote(page, '4080.3', '4080.5');

  await page.goto('/#/signal');
  await page.getByRole('button', { name: 'New signal' }).click();
  await page.getByLabel('Reference entry price').fill('4080');
  await page.getByRole('button', { name: 'Create signal & preview' }).click();

  // Staged ladder from the configured offsets
  const ladder = page.locator('table').first();
  for (const px of ['4080.00', '4077.00', '4075.00', '4073.00', '4071.00']) await expect(ladder.getByText(px)).toBeVisible();
  await expect(page.getByText('5 ready')).toBeVisible();
  // Per-account levels: group B fills at 4077 → SL 4062, TP 4080
  await expect(page.getByText('BUY LIMIT @ 4077.00 · SL 4062.00 · TP 4080.00')).toBeVisible();
  await expect(page.getByText('0.33 lots · risk 495.00 USD').first()).toBeVisible();

  await page.getByRole('button', { name: /Authorise automatic groups/ }).click();
  await expect(page.getByRole('dialog')).toContainText('5 order(s) will be sent to Simulator');
  await page.getByRole('button', { name: 'Submit to simulator' }).click();
  await expect(page.getByText('5 already submitted')).toBeVisible();

  // Touch is not a fill
  await setQuote(page, '4079.8', '4080');
  await expect(page.getByText('Pending / working orders (5)')).toBeVisible();
  await expect(page.getByText('Open positions (0)')).toBeVisible();

  // Trade through 4080 → group A fills
  await setQuote(page, '4079.7', '4079.9');
  await expect(page.getByText('Open positions (1)')).toBeVisible();
  await expect(page.getByText('BUY 0.33 XAUUSD @ 4080 (actual fill) · SL 4065 · TP 4083')).toBeVisible();

  // Extended TP
  await page.goto('/#/signal');
  await page.getByPlaceholder('Extended TP price').fill('4149');
  await page.getByRole('button', { name: 'Review extended TP' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Position @ 4080: TP 4083 → 4149 (SL 4065 unchanged)');
  await page.getByRole('button', { name: 'Send TP modifications' }).click();
  await expect(page.getByText('shared absolute target 4149')).toBeVisible();

  await page.goto('/#/orders');
  await expect(page.getByText('BUY 0.33 XAUUSD @ 4080 (actual fill) · SL 4065 · TP 4149')).toBeVisible();

  await page.goto('/#/audit');
  await expect(page.getByText(/Extended TP 4149 activated/)).toBeVisible();
  await noHorizontalOverflow(page);
});

test('emergency disable cancels working orders and blocks submissions', async ({ page }) => {
  await loadDemo(page);
  await setQuote(page, '4080.3', '4080.5');
  await page.goto('/#/signal');
  await page.getByRole('button', { name: 'New signal' }).click();
  await page.getByLabel('Reference entry price').fill('4080');
  await page.getByRole('button', { name: 'Create signal & preview' }).click();
  await page.getByRole('button', { name: /Authorise automatic groups/ }).click();
  await page.getByRole('button', { name: 'Submit to simulator' }).click();
  await expect(page.getByText('5 already submitted')).toBeVisible();

  await page.goto('/#/orders');
  await page.getByRole('button', { name: 'Emergency disable' }).click();
  await page.getByRole('button', { name: 'Disable everything' }).click();
  await expect(page.getByText('EMERGENCY DISABLE ACTIVE')).toBeVisible();
  await expect(page.getByText('Pending / working orders (0)')).toBeVisible();
});

test('MT5 provider is shown as unavailable and blocks every order', async ({ page }) => {
  await loadDemo(page);
  await page.goto('/#/settings');
  await page.getByRole('radio', { name: /MT5/ }).check();
  await expect(page.getByText('MT5 UNAVAILABLE', { exact: true })).toBeVisible();
  await page.goto('/#/signal');
  await page.getByRole('button', { name: 'New signal' }).click();
  await page.getByLabel('Reference entry price').fill('4080');
  await page.getByRole('button', { name: 'Create signal & preview' }).click();
  await expect(page.getByText('5 blocked')).toBeVisible();
  await expect(page.getByRole('button', { name: /Authorise automatic groups/ })).toBeDisabled();
});

test('bottom navigation reaches every section', async ({ page }) => {
  await page.getByRole('link', { name: 'More' }).click();
  for (const name of ['MT5 servers', 'Account groups', 'Staged entries', 'Risk overview', 'Prop-firm compatibility', 'Audit history', 'Settings']) {
    await page.goto('/#/more');
    await page.getByRole('button', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noHorizontalOverflow(page);
  }
});
