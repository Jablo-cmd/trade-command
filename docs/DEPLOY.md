# Deploying to trade.aurisnexus.co.za (GitHub Pages)

Every push to `main` runs `.github/workflows/pages.yml`, which type-checks, lints, tests and builds the app, then publishes `dist/` to GitHub Pages. If any check fails, nothing is deployed. The app uses hash routing (`#/accounts`), so Pages needs no rewrites. You can also re-run the deploy by hand from **Actions → Deploy to GitHub Pages → Run workflow**.

The workflow bakes in the Supabase URL and **publishable** key. They're public by design, and RLS protects the data. The service-role key must never appear in this repo or in any `VITE_` variable.

## One-time setup

1. **Make the repo public.** In the repo, go to **Settings → General → Danger Zone → Change visibility → Public**. Free GitHub plans only serve Pages from public repos.
2. **Turn on Pages.** In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. **DNS at HostAfrica.** In the DNS zone for `aurisnexus.co.za`, add a record:
   - Type `CNAME`, name `trade`, value `jablo-cmd.github.io`

   This doesn't change anything for the main site.
4. **Custom domain.** In **Settings → Pages → Custom domain**, enter `trade.aurisnexus.co.za` and save. Once the DNS check passes, tick **Enforce HTTPS**. The certificate can take up to about an hour.
5. **Supabase Auth URLs.** In the dashboard, go to **Authentication → URL Configuration**:
   - Site URL: `https://trade.aurisnexus.co.za`
   - Redirect URLs: add `https://trade.aurisnexus.co.za/**`

   Do this before signing up, so confirmation emails link to the right place.
6. **First deploy.** Go to **Actions → Deploy to GitHub Pages → Run workflow**, or push to `main`.

## After your account exists

This is a single-owner console. Once you've signed up, turn off **Allow new users to sign up** in Supabase (**Authentication → Sign In / Providers**).

## Notes

- GitHub Pages doesn't let you set custom response headers. The app sets `noindex` through `<meta name="robots">` and `robots.txt`.
- After a deploy, an installed copy picks up the new version the next time it's opened (the service worker uses network-first for pages).
