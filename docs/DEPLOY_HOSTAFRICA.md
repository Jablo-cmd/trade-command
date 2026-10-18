# Deploying to trade.aurisnexus.co.za (HostAfrica cPanel)

The app is static files, so any Apache host works. It uses hash routing (`#/accounts`), so it needs no server-side rewrites. `public/.htaccess` ships with the build. It does the following:
- forces HTTPS;
- sets security headers (HSTS, nosniff, `X-Frame-Options: DENY`) and `noindex`;
- never caches `index.html`, `sw.js` or the manifest, so updates show up;
- caches hashed `/assets/` for a year;
- uses `RewriteOptions IgnoreInherit`, so the main site's `.htaccess` above it can't redirect app traffic.

It was tested on Apache 2.4 both standalone and nested under the main site's `.htaccess`.

## Build

```bash
VITE_SUPABASE_URL=https://wdnuqkwrkpuazuulipuh.supabase.co \
VITE_SUPABASE_ANON_KEY=<publishable key> \
npm run build
cd dist && zip -r ../trade-command-site.zip .   # includes .htaccess
```

The publishable key is safe to ship to browsers; RLS protects the data. Never use the service-role key here.

## One-time setup

1. **Subdomain.** In cPanel, go to **Domains** → **Create A New Domain** (on older cPanel: **Subdomains**). Enter `trade.aurisnexus.co.za`, untick "Share document root", and note the folder it creates (e.g. `trade.aurisnexus.co.za/` or `public_html/trade/`).
2. **SSL.** Go to **SSL/TLS Status** and select **Run AutoSSL**. Wait until the subdomain shows a valid certificate. This is required: the main site's HSTS header (`includeSubDomains`) makes browsers refuse plain HTTP on every subdomain.
3. **Supabase Auth URLs.** In the dashboard, go to **Authentication → URL Configuration**:
   - Site URL: `https://trade.aurisnexus.co.za`
   - Redirect URLs: add `https://trade.aurisnexus.co.za/**`

   Without this, sign-up confirmation emails link to `localhost`.

## Upload (first time and every update)

1. In **File Manager**, open the subdomain's folder. On an update, delete the old `assets/` folder first.
2. **Upload** `trade-command-site.zip`, then right-click it and choose **Extract**, then delete the zip. Turn on **Settings → Show Hidden Files** to confirm `.htaccess` is there.
3. Open `https://trade.aurisnexus.co.za` and create your account. If an older version still shows, close and reopen the app; the service worker updates on the next load.

## After your account exists

This is a single-owner console. Once you've signed up, turn off **Allow new users to sign up** in Supabase (**Authentication → Sign In / Providers**). RLS already isolates other users' data, but nobody else needs an account.
