# Trade Command

Private, mobile-first trading operations console for managing **up to 40 of the owner's own** prop-firm trading accounts: accounts, MT5 server directory, groups, master signal, staged entries, per-account risk sizing, take-profit management and order-state monitoring.

> **V1 is simulation-only.** No broker connector is installed, live execution is hard-disabled (`LIVE_EXECUTION_ENABLED = false`), and no real order has ever been sent by this code. Trade Command is not a broker, custodian, payment processor or a service for pooling other traders' money.

---

## Feature status

| Area | Status |
|---|---|
| Accounts (≤ 40, enforced in UI, store and DB trigger), risk settings, manual balance/equity snapshots, FX rates | **Functional** |
| Server directory: search, custom entries, edit/remove, source + verification date, verified vs user-supplied badges, JSON import | **Functional** (ships empty: no server names are invented) |
| Per-server instrument specifications (tick size/value, volume min/max/step, min stop distance, commission) | **Functional** |
| Groups: create, rename, reorder, any size, enable/disable, manual/automatic staging, offset, approval, group risk cap | **Functional** |
| Master signal: BUY/SELL, reference entry, strategy TP/SL, optional extended TP, group participation, market entry for zero-offset group | **Functional** |
| Execution preview: per-account eligibility, levels, limit validity, risk sizing, blockers and warnings | **Functional** |
| Risk engine (budget, tick value, volume step, min/max volume, commission, FX, daily loss, drawdown, aggregate + group exposure) | **Functional, unit-tested** |
| Prop-firm compatibility profiles (9 rule items, source + date required) | **Functional**: all rules default to *unknown*, which blocks live execution |
| Order submission, fills, partial fills, cancellation, TP modification, reconciliation, emergency disable | **Simulation only** (labelled simulator) |
| MT5 execution | **Blocked**: interface + "unavailable" provider only (see [docs/MT5_CONNECTOR.md](docs/MT5_CONNECTOR.md)) |
| Supabase Auth + Postgres persistence | **Schema deployed** to the owner's project (17 tables, RLS on all). The schema and RLS are tested on local PostgreSQL, and the adapter is unit-tested against a fake client. The app has not yet been exercised end-to-end against the live project. |
| Audit log (credential redaction, append-only in DB) | **Functional** |
| PWA (manifest + app-shell service worker) | **Functional** (production build) |

## Strategy conventions (owner-defined)

These are configurable defaults labelled as the owner's convention. They are **not** broker or MT5 definitions.

- **Default TP:** "30 pips" on XAUUSD = **3.00** of quoted price. BUY TP = actual entry + 3.00; SELL TP = actual entry − 3.00.
- **Stop-loss:** fixed **15.00** price move from each position's **actual** entry. BUY SL = entry − 15.00; SELL SL = entry + 15.00. This is a price distance, **not** a $15 monetary loss.
- TP and SL are recomputed from the actual fill price; for multiple or partial fills, from the volume-weighted average fill. If the provider's levels differ, a modification is requested and audited.
- **Extended TP** is a shared *absolute* price, such as 4149. It applies to open positions (via a modification request), pending entries, and later groups until reset or the setup closes. It is shown as *requested* until the provider confirms it, and a TP change never changes the SL.
- **Monetary risk** comes only from the broker's instrument spec. If the spec is missing, the order is rejected. If the spec is not verified, the result is *unverified*: allowed in simulation, blocked for live.

## Technology

React 19 · TypeScript (strict) · Vite 8 · Vitest 5 · Playwright 1.56 · ESLint 10 · Supabase JS v2 (Auth + Postgres + RLS) · plain CSS (mobile-first, light/dark) · PWA.

```
src/domain/      pure trading logic: price/tick maths, strategy, staging, risk, compatibility,
                 eligibility, plan builder, order state machine, extended TP, audit
src/execution/   provider interface, simulator, MT5-unavailable provider, orchestrator
src/state/       store (audited actions), local + Supabase repositories, demo fixtures
src/ui/          components and pages (no trading maths in components)
supabase/        versioned migrations + local RLS test suite
e2e/             Playwright mobile tests
docs/            architecture, MT5 connector, security, prop-firm verification
```

## Local setup

Requires Node ≥ 20.19 (developed on Node 22).

```bash
npm install
npm run dev            # http://localhost:5173
```

With no environment variables, the app runs in **local-only mode**: data stays in this browser's localStorage and there is no login. To explore, open **Settings → Load demo fixtures**. This loads a fictional firm and server, an illustrative unverified XAUUSD spec, 5 DEMO accounts and groups A–E with offsets 0/3/5/7/9.

Typical simulated walkthrough:
1. **Orders → Simulator controls:** enter a simulated quote, e.g. bid 4080.30 / ask 4080.50. This is a typed value, not market data.
2. **Signal → New signal:** BUY XAUUSD at 4080. Review the per-account preview, then **Authorise automatic groups**.
3. **Orders:** move the simulated quote to 4079.70 / 4079.90. Group A fills; B–E stay pending. A quote that merely touches the limit does not fill it.
4. **Signal → Review extended TP** at 4149, check the affected items, confirm.
5. Try **fault injection** (rejections, partial fills, failed TP changes) and **Emergency disable**.

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc -b` strict type check |
| `npm run lint` | ESLint (incl. React hooks rules) |
| `npm test` | Vitest unit + integration tests |
| `npm run test:e2e` | Playwright on a Pixel 7 profile (builds and serves `vite preview`) |
| `npm run test:rls` | Applies migrations to a **disposable local PostgreSQL** cluster and runs RLS/constraint tests (needs PostgreSQL server binaries, e.g. `/usr/lib/postgresql/16/bin`) |
| `npm run build` | Type check + production build to `dist/` |
| `npm run check` | typecheck + lint + test + build |

## Environment variables

Copy `.env.example` to `.env.local`. Never commit real values.

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL. Leave blank for local-only mode. |
| `VITE_SUPABASE_ANON_KEY` | Supabase **publishable/anon** key. **Never** put the service-role key in a `VITE_` variable, because those are bundled into the browser. |

## Supabase setup (when you choose to)

Migrations 0001–0003 have been applied to the owner's dedicated "Trade Command" project (`wdnuqkwrkpuazuulipuh`, applied 2026-10-18). For a new project:

1. Create a project (a free tier is sufficient for development) and enable email/password auth.
2. Apply the migrations in order. With the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`. Alternatively, paste `supabase/migrations/*.sql` into the SQL editor in filename order. **Do not** run `supabase/tests/00_local_supabase_shim.sql` against Supabase; it only emulates `auth` locally.
3. Put the URL and anon key in `.env.local` and restart `npm run dev`. The app then shows a sign-in screen and syncs configuration, signals and audit events to your RLS-protected rows.
4. Simulated orders, fills and positions stay in the browser. In the database, `orders`, `fills`, `positions` and `execution_events` are **read-only for clients**; only a trusted backend (service role) may write them.

## Security model (summary, details in [docs/SECURITY.md](docs/SECURITY.md))

- RLS is enabled **and forced** on every table. Owners have CRUD on their configuration rows; execution records are read-only to clients; the audit log is append-only; `anon` has no access.
- Composite `(id, user_id)` foreign keys prevent linking another user's rows.
- DB invariants include:
  - the 40-account limit;
  - clients cannot claim a `connected` broker status;
  - "verified" or "permitted" requires a source and date;
  - SL/TP must be on the correct side of entry;
  - `filled_volume ≤ volume`;
  - a unique `client_order_id` acts as the idempotency key;
  - unredacted secrets are rejected in audit payloads.
- No passwords, investor passwords or API keys are requested, stored or logged. Audit details are redacted client-side and checked again in the DB.
- Duplicate orders are prevented at three layers: plan (`already_submitted`), orchestrator, and provider/DB idempotency on `clientOrderId = signal:group:account`.
- Every action is audited. The simulator is labelled at every level: banner, badges and `simulated` flags on orders, fills, positions and events.

## Execution architecture

See [docs/EXECUTION_ARCHITECTURE.md](docs/EXECUTION_ARCHITECTURE.md). In short, the browser holds only UI and preview logic. A real connector must run server-side behind authenticated endpoints and must re-validate risk before every submission. The provider interface explicitly represents `unsupported`, `disconnected`, `unauthorized` and `unverified`.

## Simulator limitations

- Prices are typed in by you; there is no market feed. Limits fill at the limit price only when the quote trades **through** them by at least one tick. Gap fills at a better price are opt-in.
- There is no slippage model, spread widening, swaps, margin, stop-outs, requotes, broker-specific rejection codes or session calendar. The session is a manual open/closed toggle.
- Hedging mode only: one position per order. Netting accounts are not modelled.
- It does not invent balances. Equity snapshots are entered manually.

## Prop-firm verification

Every rule defaults to *unknown*, and unknown means live is blocked. See [docs/PROP_FIRM_VERIFICATION.md](docs/PROP_FIRM_VERIFICATION.md). The app contains no randomisation, jitter, timing manipulation or any mechanism to disguise copying or evade firm detection, and none should be added.

## Known limitations

- Live execution: none. There is no MT5 connector, and the backend execution service is not built.
- Supabase sync has not been exercised against a live project. Sync is last-write-wins from a single device; there is no conflict resolution for concurrent editing on multiple devices.
- Snapshot staleness on the Risk page is evaluated when the page opens.
- A failed automatic SL/TP re-base is not retried automatically; it is shown as *failed* with the reason.
- Trading-session calendars, news windows and broker minimum-distance rules are only as good as the data you enter.
- Accessibility has been considered (labels, focus rings, 44px targets, dialogs) but not audited with assistive technology.

## Roadmap

1. Server-side execution service (Supabase Edge Function or a dedicated service) with a job queue, service-role writes and risk re-validation.
2. Windows MT5 connector host (see the MT5 doc), once broker and firm permission is verified per account.
3. Reconciliation daemon and alerting (push notifications on rejects, unknown states and failed modifications).
4. Provider-sourced account metrics and instrument specs, replacing manual entry.
5. Session/news calendar, slippage limits, and multi-device conflict handling.

**Sources consulted for the MT5 notes:** [MQL5: Python integration overview](https://docs.mql4.com/mql5_language/mql5_functions/mql5_python) · [MQL5 book: installing Python and the MetaTrader5 package](https://www.mql5.com/de/book/advanced/python/python_funcs_overview) · [MQL5 forum: multiple terminals and initialize()](https://mql5.com/en/forum/393357/29246235)
