"""In-memory fakes for the database and MT5 terminal (tests only)."""
from __future__ import annotations

import copy
import itertools
from datetime import datetime, timedelta, timezone

from tradecommand_connector.gateway import (
    AccountInfo, HistoryOrder, Mt5Deal, Mt5Order, Mt5Position, SendResult, SymbolInfo, Tick,
)

NOW = datetime(2026, 1, 15, 10, 0, tzinfo=timezone.utc)
USER = "user-a"
ACCOUNT = "acc-1"
SIGNAL = "sig-1"


class FakeDb:
    def __init__(self):
        self.accounts = {ACCOUNT: {
            "id": ACCOUNT, "user_id": USER, "trading_enabled": True, "execution_mode": "live_automated",
            "compatibility_profile_id": "prof-1", "account_size": 100000, "currency": "USD", "connection_status": "not_configured",
        }}
        self.risk = {ACCOUNT: {"account_id": ACCOUNT, "max_risk_per_trade": 500}}
        self.items = [{"profile_id": "prof-1", "item_key": k, "status": "permitted", "source": "https://ftmo.com/en/faq/", "verified_on": "2026-01-10"}
                      for k in ("automatedExecution", "eaOrApi", "vpsVpn", "personalAccountCopying", "pendingOrders",
                                "hedgingNetting", "instrumentRestrictions", "newsSessionRestrictions", "programLimitations")]
        self.emergency: set[str] = set()
        self.signals = {SIGNAL: {"id": SIGNAL, "user_id": USER, "symbol": "XAUUSD", "direction": "BUY", "status": "active",
                                 "stop_loss_distance": 15, "default_tp_pips": 30, "strategy_pip_size": 0.1,
                                 "tp_mode": "default_per_entry", "extended_tp_price": None}}
        self.commands: list[dict] = []
        self.orders: dict[str, dict] = {}
        self.fills: dict[str, dict] = {}
        self.positions: dict[str, dict] = {}
        self.events: list[dict] = []
        self.heartbeats: dict[str, dict] = {}
        self._ids = itertools.count(1)

    def queue(self, kind, client_order_id=None, payload=None, user=USER, created_at=NOW, signal_id=SIGNAL):
        cmd = {"id": f"cmd-{next(self._ids)}", "user_id": user, "kind": kind, "account_id": ACCOUNT, "signal_id": signal_id,
               "client_order_id": client_order_id, "payload": payload or {}, "status": "pending", "created_at": created_at.isoformat()}
        self.commands.append(cmd)
        return cmd

    # Db protocol
    def get_account(self, account_id): return copy.deepcopy(self.accounts.get(account_id))
    def get_risk_settings(self, account_id): return self.risk.get(account_id)
    def get_compat_items(self, profile_id): return [i for i in self.items if i["profile_id"] == profile_id]
    def get_emergency(self, user_id): return user_id in self.emergency
    def set_emergency(self, user_id): self.emergency.add(user_id)
    def get_signal(self, signal_id): return self.signals.get(signal_id)

    def claim_pending(self, account_id, connector_id, limit=20):
        out = []
        for c in self.commands:
            if c["account_id"] == account_id and c["status"] == "pending":
                c.update(status="claimed", claimed_by=connector_id)
                out.append(copy.deepcopy(c))
        return out[:limit]

    def complete(self, command_id, status, result):
        c = next(c for c in self.commands if c["id"] == command_id)
        c.update(status=status, result=result)

    def get_orders(self, account_id): return [copy.deepcopy(o) for o in self.orders.values() if o["account_id"] == account_id]
    def get_order_by_client_id(self, user_id, cid):
        return next((copy.deepcopy(o) for o in self.orders.values() if o["user_id"] == user_id and o["client_order_id"] == cid), None)

    def insert_order(self, row):
        assert not any(o["client_order_id"] == row["client_order_id"] for o in self.orders.values()), "duplicate client_order_id"
        self.orders[row["id"]] = dict(row)
        return dict(row)

    def update_order(self, order_id, patch): self.orders[order_id].update(patch)
    def get_fills(self, order_id): return [f for f in self.fills.values() if f["order_id"] == order_id]
    def insert_fill(self, row): self.fills.setdefault(row["provider_fill_id"], dict(row))
    def get_position(self, order_id): return copy.deepcopy(self.positions.get(order_id))
    def upsert_position(self, row): self.positions[row["order_id"]] = {**self.positions.get(row["order_id"], {}), **row}
    def insert_event(self, row): self.events.append(row)
    def set_connection_status(self, account_id, status): self.accounts[account_id]["connection_status"] = status
    def upsert_heartbeat(self, row): self.heartbeats[row["account_id"]] = row


class FakeMt5:
    """Minimal hedging-account MT5: limits fill when price trades through; SL/TP edits; history."""

    def __init__(self, trade_mode="demo", login=111, server="FTMO-Demo"):
        self.info = AccountInfo(login, server, 100000.0, 100000.0, "USD", trade_mode, True)
        self.connected = True
        self.sym = SymbolInfo(0.01, 1.0, 0.01, 2, 0.01, 50.0, 0.01, 0, True)
        self.quote = Tick(4080.3, 4080.5, NOW)
        self._orders: dict[int, Mt5Order] = {}
        self._magic: dict[int, int] = {}
        self._positions: dict[int, Mt5Position] = {}
        self._deals: list[Mt5Deal] = []
        self._history: dict[int, HistoryOrder] = {}
        self.sent: list[dict] = []
        self.fail_next: tuple[int, str] | None = None
        self.raise_next = False
        self.fail_sltp = False
        self._tickets = itertools.count(5001)

    def connect(self): return self.connected
    def last_error(self): return "-10004: no IPC connection"
    def account_info(self): return self.info if self.connected else None
    def symbol_info(self, symbol): return self.sym if symbol == "XAUUSD" else None
    def tick(self, symbol): return self.quote if symbol == "XAUUSD" else None
    def orders(self, magic): return [o for t, o in self._orders.items() if magic is None or self._magic[t] == magic]
    def positions(self, magic): return [p for p in self._positions.values() if magic is None or self._magic.get(p.identifier) == magic]
    def deals_since(self, since, magic): return [d for d in self._deals if d.time >= since and (magic is None or self._magic.get(d.order) == magic)]
    def history_order(self, ticket): return self._history.get(ticket)

    def send(self, req):
        self.sent.append(dict(req))
        if self.raise_next:
            self.raise_next = False
            # Simulate "request may have reached the server but we got no answer".
            self._place(req)
            raise TimeoutError("terminal did not respond")
        if self.fail_next:
            code, msg = self.fail_next
            self.fail_next = None
            return SendResult(code, msg, 0, 0)
        a = req["action"]
        if a in ("pending", "deal"):
            t = self._place(req)
            return SendResult(10009 if a == "deal" else 10008, "done", t, 0)
        if a == "remove":
            o = self._orders.pop(req["order"], None)
            if not o:
                return SendResult(10013, "invalid request", 0, 0)
            self._history[o.ticket] = HistoryOrder(o.ticket, "canceled", o.volume_initial, o.volume_current)
            return SendResult(10009, "done", o.ticket, 0)
        if a == "modify":
            o = self._orders[req["order"]]
            o.sl, o.tp = req["sl"], req["tp"]
            return SendResult(10009, "done", o.ticket, 0)
        if a == "sltp":
            if self.fail_sltp:
                return SendResult(10016, "invalid stops", 0, 0)
            p = next(p for p in self._positions.values() if p.ticket == req["position"])
            p.sl, p.tp = req["sl"], req["tp"]
            return SendResult(10009, "done", 0, 0)
        raise AssertionError(a)

    def _place(self, req):
        t = next(self._tickets)
        self._magic[t] = req["magic"]
        o = Mt5Order(t, req["symbol"], req["type"] if req["action"] == "pending" else req["type"], req["volume"], req["volume"],
                     req["price"], req["sl"], req["tp"], req["comment"])
        if req["action"] == "deal":
            self._fill(o, req["price"], req["volume"])
        else:
            self._orders[t] = o
        return t

    def _fill(self, o: Mt5Order, price: float, volume: float):
        self._deals.append(Mt5Deal(next(self._tickets), o.ticket, o.ticket, "in", price, volume, 0, 0, 0, NOW, o.comment))
        prev = self._positions.get(o.ticket)
        vol = round((prev.volume if prev else 0) + volume, 2)
        entry = round(((prev.price_open * prev.volume) if prev else 0) / vol + price * volume / vol, 2) if prev else price
        self._positions[o.ticket] = Mt5Position(o.ticket + 100000, o.ticket, o.symbol, o.type.split("_")[0], vol, entry,
                                                prev.sl if prev else o.sl, prev.tp if prev else o.tp, o.comment)
        o.volume_current = round(o.volume_current - volume, 2)
        if o.volume_current <= 0:
            self._orders.pop(o.ticket, None)
            self._history[o.ticket] = HistoryOrder(o.ticket, "filled", o.volume_initial, 0)

    # test helpers
    def fill_pending(self, ticket: int, price: float, volume: float | None = None):
        o = self._orders[ticket]
        self.quote = Tick(price - 0.2, price, NOW)  # a limit fills when the market trades at its price
        self._fill(o, price, volume if volume is not None else o.volume_current)

    def close_position(self, identifier: int, price: float):
        p = self._positions.pop(identifier)
        closing_order = next(self._tickets)
        self._magic[closing_order] = self._magic[identifier]  # SL/TP closes carry the position's magic
        self._deals.append(Mt5Deal(next(self._tickets), closing_order, identifier, "out", price, p.volume, -50.0, 0, 0, NOW, p.comment))
