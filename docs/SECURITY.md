# Security, backup, auditability and incident response

## Data and secrets
- No credential fields exist in the schema or the app model. Audit details are recursively redacted client-side (`sanitize`). The DB rejects audit or execution payloads that contain sensitive-looking keys with unredacted values.
- Only the Supabase **anon/publishable** key may be used in the browser. The service-role key belongs only on a backend or connector host.
- `.env*` files are git-ignored, except `.env.example`, which contains placeholders only.

## Authorisation (tested by `npm run test:rls`, 32 checks)
- RLS is enabled and forced on all 17 tables; `anon` has no grants.
- The owner has CRUD on configuration tables; `orders`, `fills`, `positions` and `execution_events` are SELECT-only; `audit_events` is SELECT + INSERT only.
- Cross-user linking is prevented by composite foreign keys, and ownership transfer is prevented by `WITH CHECK`.
- Server-side invariants (also listed in the README): 40-account cap, protected connection status, evidence for verified/permitted, SL/TP direction, overfill prevention, idempotent `client_order_id`.

## Trading safety
- Live execution is compiled off (`LIVE_EXECUTION_ENABLED = false`), and the orchestrator refuses non-simulated providers.
- Emergency disable cancels all working orders and blocks new submissions. Open positions keep their SL/TP.
- Orders with an unknown outcome are never auto-retried; they must be reconciled.

## Backup and recovery
- Local mode: use **Settings → Export backup** (JSON) regularly. Import replaces all local data.
- Supabase: use the project's automated backups or point-in-time recovery (depending on plan), plus periodic `pg_dump` of the `public` schema. Restore into a staging project first.
- Migrations are versioned in `supabase/migrations`. Apply them in order and never edit an applied migration; add a new one instead.

## Auditability
- Every user action and execution step creates an audit event with a timestamp, category, entity id and a simulated flag. In the DB, audit rows cannot be updated or deleted by clients.

## Incident response (once live execution exists)
1. Press **Emergency disable**. The server-side kill switch must also stop the connector.
2. Reconcile against the broker terminal or statement. The provider is the source of truth.
3. Close or adjust positions manually in the terminal if needed.
4. Export the audit log, rotate any exposed credentials, and record a timeline.
5. Fix the root cause, add a test, and re-verify before re-enabling.
