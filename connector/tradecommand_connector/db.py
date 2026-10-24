"""Database access for the connector, over Supabase's REST API (PostgREST).

Uses the service-role key, which bypasses RLS. It must live only on the connector host,
in an environment variable or the OS credential store, never in the app or in Git.
Every query is still scoped to the configured account and its owner.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol

Row = dict[str, Any]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Db(Protocol):
    def get_account(self, account_id: str) -> Row | None: ...
    def get_risk_settings(self, account_id: str) -> Row | None: ...
    def get_compat_items(self, profile_id: str) -> list[Row]: ...
    def get_emergency(self, user_id: str) -> bool: ...
    def set_emergency(self, user_id: str) -> None: ...
    def get_signal(self, signal_id: str) -> Row | None: ...
    def claim_pending(self, account_id: str, connector_id: str, limit: int = 20) -> list[Row]: ...
    def complete(self, command_id: str, status: str, result: Row) -> None: ...
    def get_orders(self, account_id: str) -> list[Row]: ...
    def get_order_by_client_id(self, user_id: str, client_order_id: str) -> Row | None: ...
    def insert_order(self, row: Row) -> Row: ...
    def update_order(self, order_id: str, patch: Row) -> None: ...
    def get_fills(self, order_id: str) -> list[Row]: ...
    def insert_fill(self, row: Row) -> None: ...
    def get_position(self, order_id: str) -> Row | None: ...
    def upsert_position(self, row: Row) -> None: ...
    def insert_event(self, row: Row) -> None: ...
    def set_connection_status(self, account_id: str, status: str) -> None: ...
    def upsert_heartbeat(self, row: Row) -> None: ...


class DbError(RuntimeError):
    pass


class SupabaseRest:
    def __init__(self, url: str, service_key: str, timeout: float = 15.0):
        self.base = url.rstrip("/") + "/rest/v1/"
        self._key = service_key
        self.timeout = timeout

    def _req(self, method: str, path: str, params: dict[str, str] | None = None, body: Any = None, prefer: str | None = None) -> Any:
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        headers = {"apikey": self._key, "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body, default=str).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise DbError(f"{method} {path}: HTTP {e.code} {e.read()[:300]!r}") from None

    def _one(self, table: str, **filters: str) -> Row | None:
        rows = self._req("GET", table, {**{k: f"eq.{v}" for k, v in filters.items()}, "select": "*", "limit": "1"})
        return rows[0] if rows else None

    def get_account(self, account_id: str) -> Row | None:
        return self._one("trading_accounts", id=account_id)

    def get_risk_settings(self, account_id: str) -> Row | None:
        return self._one("risk_settings", account_id=account_id)

    def get_compat_items(self, profile_id: str) -> list[Row]:
        return self._req("GET", "compatibility_items", {"profile_id": f"eq.{profile_id}", "select": "*"}) or []

    def get_emergency(self, user_id: str) -> bool:
        p = self._one("profiles", id=user_id)
        return bool(p and p.get("emergency_disabled"))

    def set_emergency(self, user_id: str) -> None:
        self._req("POST", "profiles", {"on_conflict": "id"}, [{"id": user_id, "emergency_disabled": True}],
                  prefer="resolution=merge-duplicates")

    def get_signal(self, signal_id: str) -> Row | None:
        return self._one("master_signals", id=signal_id)

    def claim_pending(self, account_id: str, connector_id: str, limit: int = 20) -> list[Row]:
        pending = self._req("GET", "execution_commands", {
            "account_id": f"eq.{account_id}", "status": "eq.pending", "select": "id", "order": "created_at.asc", "limit": str(limit)})
        claimed: list[Row] = []
        for row in pending or []:
            # Conditional update: only one connector can move a command out of 'pending'.
            got = self._req("PATCH", "execution_commands", {"id": f"eq.{row['id']}", "status": "eq.pending"},
                            {"status": "claimed", "claimed_by": connector_id, "claimed_at": _now()}, prefer="return=representation")
            if got:
                claimed.append(got[0])
        return claimed

    def complete(self, command_id: str, status: str, result: Row) -> None:
        self._req("PATCH", "execution_commands", {"id": f"eq.{command_id}"},
                  {"status": status, "result": result, "completed_at": _now()})

    def get_orders(self, account_id: str) -> list[Row]:
        return self._req("GET", "orders", {"account_id": f"eq.{account_id}", "select": "*"}) or []

    def get_order_by_client_id(self, user_id: str, client_order_id: str) -> Row | None:
        return self._one("orders", user_id=user_id, client_order_id=client_order_id)

    def insert_order(self, row: Row) -> Row:
        return self._req("POST", "orders", None, [row], prefer="return=representation")[0]

    def update_order(self, order_id: str, patch: Row) -> None:
        self._req("PATCH", "orders", {"id": f"eq.{order_id}"}, patch)

    def get_fills(self, order_id: str) -> list[Row]:
        return self._req("GET", "fills", {"order_id": f"eq.{order_id}", "select": "*"}) or []

    def insert_fill(self, row: Row) -> None:
        self._req("POST", "fills", {"on_conflict": "user_id,provider_fill_id"}, [row], prefer="resolution=ignore-duplicates")

    def get_position(self, order_id: str) -> Row | None:
        return self._one("positions", order_id=order_id)

    def upsert_position(self, row: Row) -> None:
        self._req("POST", "positions", {"on_conflict": "order_id"}, [row], prefer="resolution=merge-duplicates")

    def insert_event(self, row: Row) -> None:
        self._req("POST", "execution_events", None, [row])

    def set_connection_status(self, account_id: str, status: str) -> None:
        self._req("PATCH", "trading_accounts", {"id": f"eq.{account_id}"}, {"connection_status": status})

    def upsert_heartbeat(self, row: Row) -> None:
        self._req("POST", "connector_heartbeats", {"on_conflict": "account_id"}, [row], prefer="resolution=merge-duplicates")
