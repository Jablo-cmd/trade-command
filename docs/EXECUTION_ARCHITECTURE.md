# Execution architecture

## Layers

```
UI (React)  →  Store (audited actions)  →  Domain (pure)              →  Orchestrator  →  ExecutionProvider
                                            plan / risk / eligibility                        ├─ SimulatedExecutionProvider (V1)
                                                                                             └─ UnavailableMt5Provider (reports "unsupported")
```

- **Domain** (`src/domain`) contains no I/O. It builds per-account `PlannedOrder`s with status `ready | blocked | awaiting_approval | already_submitted`, their blockers and their risk results.
- **Orchestrator** (`src/execution/orchestrator.ts`):
  - submits only `ready` orders;
  - refuses any non-simulated provider while `LIVE_EXECUTION_ENABLED` is `false`;
  - refuses all submissions while emergency disable is active;
  - de-duplicates on `clientOrderId`;
  - marks orders `unknown` if a provider call throws, and never auto-resubmits them;
  - reconciles provider orders, fills and positions;
  - re-bases SL/TP on actual fills;
  - applies TP changes, which count as confirmed only after the provider confirms them.
- **Provider interface** (`src/execution/provider.ts`) covers:
  - connection state: `unsupported | disconnected | unauthorized | unverified | connected`;
  - market data, account info, orders, fills and positions;
  - idempotent submit, modify protection and cancel.

## Order lifecycle

`planned → pending_submission → submitted → acknowledged → partially_filled → filled`

The other states are `rejected`, `cancel_requested`, `cancelled`, `expired` and `unknown`. Terminal states cannot be left; invalid provider transitions are recorded as `unknown` and audited. A cancel request can still end `filled`, because of the race between the cancel and a fill.

## Required production shape (not built in V1)

A browser tab is not a persistent execution engine: it sleeps, loses connectivity and cannot hold broker sessions. Live execution must be:

1. **Server-side.** The client calls an authenticated endpoint (for example a Supabase Edge Function) with `signal_id` and the selected groups. The endpoint re-loads all data from the DB and **re-runs eligibility and risk** with provider-sourced balances, specs and quotes. It never trusts client-computed volumes.
2. **Queued.** A job is written per planned order, keyed on the unique `client_order_id`. The DB constraint makes retries idempotent.
3. **Executed by a connector host** (see `MT5_CONNECTOR.md`), which pulls jobs, talks to the terminal or API, and writes `orders`, `fills`, `positions` and `execution_events` with the service role.
4. **Reconciled** continuously. Provider state is the source of truth, and drift raises alerts.
5. **Guarded by a server-side kill switch** (`profiles.emergency_disabled`) that the connector checks before every action.
