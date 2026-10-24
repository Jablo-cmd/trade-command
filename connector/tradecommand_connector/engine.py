"""Connector engine: claims queued commands, re-validates them against live MT5 data,
acts through the gateway, and reconciles MT5 state back into the database.

Safety invariants:
  * Nothing is sent unless every check passes on THIS host with live MT5 data; the app's
    preview is never trusted (volumes, levels and risk are recomputed).
  * Real-money accounts are refused unless the config explicitly allows them.
  * One MT5 order per client_order_id: checked in the DB and in MT5 (order comment tag)
    before every send. Unknown send outcomes are never retried; reconciliation resolves them.
  * A TP change never moves the stop-loss. Results are recorded only as MT5 confirms them.
"""
from __future__ import annotations

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

from . import rules
from .db import Db, Row
from .gateway import Mt5Gateway, Mt5Position

log = logging.getLogger("tradecommand.connector")

TERMINAL = {"filled", "rejected", "cancelled", "expired"}


@dataclass
class EngineConfig:
    connector_id: str
    account_id: str
    mt5_login: int
    mt5_server: str
    symbol_map: dict[str, str] = field(default_factory=lambda: {"XAUUSD": "XAUUSD"})
    magic: int = 7031001
    allow_real_accounts: bool = False
    max_command_age_seconds: int = 120
    quote_max_age_seconds: int = 60
    server_day_utc_offset_hours: float = 0.0
    deviation_points: int = 20


def order_tag(client_order_id: str) -> str:
    """Short, stable MT5 comment identifying our order (MT5 comments are max 31 chars)."""
    return "TC" + hashlib.sha1(client_order_id.encode()).hexdigest()[:20]


class Rejected(Exception):
    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons))
        self.reasons = reasons


class Engine:
    def __init__(self, cfg: EngineConfig, db: Db, gw: Mt5Gateway, now: Callable[[], datetime] | None = None):
        self.cfg = cfg
        self.db = db
        self.gw = gw
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.healthy = False
        self._account: Row | None = None
        self._trade_mode = "unknown"

    # ------------------------------------------------------------------ loop
    def run_once(self) -> None:
        if self.heartbeat():
            self.process_commands()
            self.reconcile()

    @property
    def provider_name(self) -> str:
        return f"MT5 connector ({self._trade_mode})"

    def _event(self, event_type: str, payload: Row, order_id: str | None = None) -> None:
        if not self._account:
            return
        try:
            self.db.insert_event({
                "user_id": self._account["user_id"], "order_id": order_id, "provider_name": self.provider_name,
                "event_type": event_type, "payload": payload, "simulated": False,
            })
        except Exception:  # an audit failure must not break trading-state handling
            log.exception("failed to record event %s", event_type)

    # ------------------------------------------------------------------ heartbeat
    def heartbeat(self) -> bool:
        account = self.db.get_account(self.cfg.account_id)
        if not account:
            log.error("trading account %s not found in database", self.cfg.account_id)
            self.healthy = False
            return False
        self._account = account
        connected = self.gw.connect()
        info = self.gw.account_info() if connected else None
        verified = bool(info and info.login == self.cfg.mt5_login and info.server == self.cfg.mt5_server)
        self._trade_mode = info.trade_mode if info else "unknown"
        quotes: dict[str, Any] = {}
        if verified:
            for app_sym, broker_sym in self.cfg.symbol_map.items():
                t = self.gw.tick(broker_sym)
                if t:
                    quotes[app_sym] = {"bid": t.bid, "ask": t.ask, "time": t.time.isoformat()}
        error = None if verified else (self.gw.last_error() if not connected else "Logged-in MT5 account does not match the configured login/server.")
        self.db.upsert_heartbeat({
            "account_id": self.cfg.account_id, "user_id": account["user_id"], "connector_id": self.cfg.connector_id,
            "terminal_connected": connected, "login_verified": verified, "trade_mode": self._trade_mode,
            "trade_allowed": bool(info and info.trade_allowed), "balance": info.balance if info else None,
            "equity": info.equity if info else None, "currency": info.currency if info else None,
            "server": info.server if info else None, "quotes": quotes, "error": error, "last_seen": self.now().isoformat(),
        })
        status = "connected" if verified else ("unauthorized" if connected else "disconnected")
        if account.get("connection_status") != status:
            self.db.set_connection_status(self.cfg.account_id, status)
        self.healthy = verified
        return verified

    # ------------------------------------------------------------------ commands
    def process_commands(self) -> None:
        for cmd in self.db.claim_pending(self.cfg.account_id, self.cfg.connector_id):
            handler = {"submit": self._submit, "cancel": self._cancel, "modify_tp": self._modify_tp,
                       "emergency_disable": self._emergency}.get(cmd["kind"])
            try:
                if handler is None:
                    raise Rejected([f"Unknown command kind {cmd['kind']}"])
                result = handler(cmd)
                self.db.complete(cmd["id"], "done", result)
            except Rejected as r:
                log.warning("command %s rejected: %s", cmd["id"], r)
                self.db.complete(cmd["id"], "rejected", {"reasons": r.reasons})
                self._event("command_rejected", {"command_id": cmd["id"], "kind": cmd["kind"], "reasons": r.reasons})
            except Exception as e:  # noqa: BLE001 - every failure is recorded, never swallowed silently
                log.exception("command %s failed", cmd["id"])
                self.db.complete(cmd["id"], "failed", {"error": str(e)[:500]})
                self._event("command_failed", {"command_id": cmd["id"], "kind": cmd["kind"], "error": str(e)[:500]})

    def _common_checks(self, cmd: Row) -> list[str]:
        reasons = []
        acc = self._account or {}
        if cmd["user_id"] != acc.get("user_id"):
            reasons.append("Command owner does not match the account owner.")
        if self.db.get_emergency(acc.get("user_id", "")):
            reasons.append("Emergency disable is active.")
        return reasons

    def _submit(self, cmd: Row) -> Row:
        p = cmd["payload"]
        acc = self._account or {}
        reasons = self._common_checks(cmd)
        if reasons:
            raise Rejected(reasons)

        # 1. Idempotency: never place a second MT5 order for the same logical order.
        existing = self.db.get_order_by_client_id(cmd["user_id"], cmd["client_order_id"])
        tag = order_tag(cmd["client_order_id"])
        if existing:
            return {"duplicate": True, "order_id": existing["id"], "state": existing["state"]}
        if any(o.comment == tag for o in self.gw.orders(self.cfg.magic)) or any(x.comment == tag for x in self.gw.positions(self.cfg.magic)):
            raise Rejected(["An MT5 order with this tag already exists; reconcile before retrying."])

        # 2. Freshness, account permissions, firm rules.
        created = datetime.fromisoformat(str(cmd["created_at"]).replace("Z", "+00:00"))
        if (self.now() - created).total_seconds() > self.cfg.max_command_age_seconds:
            reasons.append(f"Command is older than {self.cfg.max_command_age_seconds}s; prices may have moved. Re-preview and resend.")
        if not acc.get("trading_enabled"):
            reasons.append("Trading is disabled for this account.")
        if acc.get("execution_mode") != "live_automated":
            reasons.append("Account execution mode is not 'live_automated'.")
        profile_id = acc.get("compatibility_profile_id")
        if not profile_id:
            reasons.append("No prop-firm compatibility profile linked; firm rules unverified.")
        else:
            reasons += [f"Firm rule not verified — {b}" for b in rules.compatibility_blockers(self.db.get_compat_items(profile_id), p.get("order_kind") == "limit")]
        info = self.gw.account_info()
        if not info:
            raise Rejected(reasons + ["MT5 account information unavailable."])
        if info.trade_mode == "real" and not self.cfg.allow_real_accounts:
            reasons.append("This is a REAL-money MT5 account and the connector config does not allow real accounts.")
        if info.trade_mode == "unknown":
            reasons.append("MT5 account type is unknown.")
        if not info.trade_allowed:
            reasons.append("Algo trading is disabled in the MT5 terminal or for this account.")

        # 3. Signal and instrument.
        signal = self.db.get_signal(cmd["signal_id"]) if cmd.get("signal_id") else None
        if not signal or signal.get("user_id") != cmd["user_id"]:
            raise Rejected(reasons + ["Signal not found for this user."])
        if signal["status"] in ("closed", "cancelled"):
            reasons.append(f"Signal is {signal['status']}.")
        direction, symbol, kind = p.get("direction"), p.get("symbol"), p.get("order_kind")
        if direction != signal["direction"] or symbol != signal["symbol"]:
            reasons.append("Command direction/symbol does not match the signal.")
        if kind not in ("limit", "market"):
            reasons.append("Unknown order kind.")
        broker_sym = self.cfg.symbol_map.get(symbol or "")
        if not broker_sym:
            raise Rejected(reasons + [f"No broker symbol mapped for {symbol} in connector config."])
        si = self.gw.symbol_info(broker_sym)
        tick = self.gw.tick(broker_sym)
        if not si or not si.trade_enabled:
            raise Rejected(reasons + [f"{broker_sym} is not tradable on this account."])
        if not tick or (self.now() - tick.time).total_seconds() > self.cfg.quote_max_age_seconds:
            raise Rejected(reasons + [f"No fresh {broker_sym} quote (market closed or feed stale)."])

        # 4. Levels recomputed from the signal's strategy — the preview is not trusted.
        entry = float(p["entry"]) if kind == "limit" else (tick.ask if direction == "BUY" else tick.bid)
        sl = rules.stop_loss(direction, entry, float(signal["stop_loss_distance"]), si.tick_size)
        tp = rules.take_profit_for(direction, entry, signal, si.tick_size)
        if kind == "limit" and (abs(sl - float(p["stop_loss"])) > si.tick_size / 2 or abs(tp - float(p["take_profit"])) > si.tick_size / 2):
            reasons.append(f"Requested SL/TP ({p['stop_loss']}/{p['take_profit']}) do not match the strategy ({sl}/{tp}).")
        min_dist = si.stops_level_points * si.point
        reasons += rules.validate_levels(direction, kind, entry, sl, tp, tick.bid, tick.ask, si.tick_size, min_dist)

        # 5. Risk, from live MT5 balances and exposure.
        volume = float(p["volume"])
        allowed = self._allowed_volume(entry, sl, si, info)
        if allowed.reasons:
            reasons += allowed.reasons
        elif volume > allowed.volume + 1e-9:
            reasons.append(f"Requested {volume} lots exceeds the {allowed.volume} lots allowed by current risk limits.")
        if rules.floor_to_step(volume, si.volume_step) != volume or volume < si.volume_min:
            reasons.append(f"Volume {volume} is not valid for this symbol (min {si.volume_min}, step {si.volume_step}).")
        if reasons:
            raise Rejected(reasons)

        # 6. Record first (so a crash leaves a trace), then send once.
        order_type = f"{direction}_{'LIMIT' if kind == 'limit' else 'MARKET'}"
        order = self.db.insert_order({
            "id": str(uuid.uuid4()), "user_id": cmd["user_id"], "client_order_id": cmd["client_order_id"],
            "signal_id": cmd["signal_id"], "group_id": p.get("group_id"), "account_id": self.cfg.account_id,
            "symbol": symbol, "direction": direction, "order_type": order_type, "volume": volume,
            "filled_volume": 0, "limit_price": entry, "stop_loss": sl, "take_profit": tp,
            "state": "pending_submission", "provider_name": self.provider_name, "simulated": False,
        })
        request = {
            "action": "pending" if kind == "limit" else "deal", "symbol": broker_sym, "volume": volume,
            "type": f"{direction}_LIMIT" if kind == "limit" else direction, "price": entry, "sl": sl, "tp": tp,
            "deviation": self.cfg.deviation_points, "magic": self.cfg.magic, "comment": tag,
        }
        try:
            res = self.gw.send(request)
        except Exception as e:  # noqa: BLE001
            self.db.update_order(order["id"], {"state": "unknown", "reject_reason": f"send outcome unknown: {e}"[:300]})
            self._event("submit_unknown", {"client_order_id": cmd["client_order_id"], "error": str(e)[:300]}, order["id"])
            return {"order_id": order["id"], "state": "unknown"}
        if not res.ok:
            self.db.update_order(order["id"], {"state": "rejected", "reject_reason": f"MT5 {res.retcode}: {res.comment}"})
            self._event("submit_rejected", {"retcode": res.retcode, "comment": res.comment}, order["id"])
            raise Rejected([f"MT5 rejected the order ({res.retcode}: {res.comment})."])
        self.db.update_order(order["id"], {"state": "acknowledged" if kind == "limit" else "submitted", "provider_order_id": str(res.order)})
        self._event("submitted", {"ticket": res.order, "volume": volume, "entry": entry, "sl": sl, "tp": tp}, order["id"])
        return {"order_id": order["id"], "ticket": res.order, "volume": volume, "entry": entry, "stop_loss": sl, "take_profit": tp}

    def _allowed_volume(self, entry: float, sl: float, si, info) -> rules.Sizing:
        acc = self._account or {}
        rs = self.db.get_risk_settings(self.cfg.account_id) or {}
        per_trade = rs.get("max_risk_per_trade")
        if per_trade is None:
            return rules.Sizing(0, 0, 0, ["Maximum risk per trade is not configured for this account."])
        committed = Decimal(0)
        for pos in self.gw.positions(None):
            if not pos.sl:
                return rules.Sizing(0, 0, 0, [f"Open position {pos.ticket} has no stop-loss; exposure is unbounded."])
            committed += rules.loss_at_stop(pos.price_open, pos.sl, pos.volume, si.tick_size, si.tick_value)
        for o in self.gw.orders(None):
            if not o.sl:
                return rules.Sizing(0, 0, 0, [f"Pending order {o.ticket} has no stop-loss; exposure is unbounded."])
            committed += rules.loss_at_stop(o.price_open, o.sl, o.volume_current, si.tick_size, si.tick_value)
        budgets = [Decimal(str(per_trade))]
        if rs.get("max_aggregate_risk") is not None:
            budgets.append(Decimal(str(rs["max_aggregate_risk"])) - committed)
        if rs.get("daily_loss_limit") is not None:
            budgets.append(Decimal(str(rs["daily_loss_limit"])) - self._daily_loss_used(info) - committed)
        if rs.get("max_total_drawdown") is not None:
            used = max(Decimal(0), Decimal(str(acc.get("account_size", info.balance))) - Decimal(str(info.equity)))
            budgets.append(Decimal(str(rs["max_total_drawdown"])) - used - committed)
        return rules.size_position(float(min(budgets)), entry, sl, si.tick_size, si.tick_value, si.volume_min, si.volume_max,
                                   si.volume_step, max_volume=rs.get("max_volume"))

    def _daily_loss_used(self, info) -> Decimal:
        offset = timedelta(hours=self.cfg.server_day_utc_offset_hours)
        server_now = self.now() + offset
        day_start = server_now.replace(hour=0, minute=0, second=0, microsecond=0) - offset
        realized = sum((Decimal(str(d.profit + d.commission + d.swap)) for d in self.gw.deals_since(day_start, None)), Decimal(0))
        floating = Decimal(str(info.equity)) - Decimal(str(info.balance))
        return max(Decimal(0), -(realized + floating))

    def _order_row(self, cmd: Row) -> Row:
        order = self.db.get_order_by_client_id(cmd["user_id"], cmd["client_order_id"])
        if not order or order["account_id"] != self.cfg.account_id or not order.get("provider_order_id"):
            raise Rejected(["Order not found on this account."])
        return order

    def _cancel(self, cmd: Row) -> Row:
        if cmd["user_id"] != (self._account or {}).get("user_id"):
            raise Rejected(["Command owner does not match the account owner."])
        order = self._order_row(cmd)
        ticket = int(order["provider_order_id"])
        if not any(o.ticket == ticket for o in self.gw.orders(self.cfg.magic)):
            raise Rejected([f"Order is no longer pending in MT5 (state {order['state']}); it may have filled."])
        res = self.gw.send({"action": "remove", "order": ticket})
        if not res.ok:
            raise Rejected([f"MT5 refused the cancel ({res.retcode}: {res.comment})."])
        self.db.update_order(order["id"], {"state": "cancelled"})
        self._event("cancelled", {"ticket": ticket}, order["id"])
        return {"order_id": order["id"], "state": "cancelled"}

    def _modify_tp(self, cmd: Row) -> Row:
        if cmd["user_id"] != (self._account or {}).get("user_id"):
            raise Rejected(["Command owner does not match the account owner."])
        order = self._order_row(cmd)
        ticket = int(order["provider_order_id"])
        new_tp = float(cmd["payload"]["take_profit"])
        broker_sym = self.cfg.symbol_map[order["symbol"]]
        si, tick = self.gw.symbol_info(broker_sym), self.gw.tick(broker_sym)
        if not si or not tick:
            raise Rejected(["No symbol data or quote available."])
        if not rules.on_tick(new_tp, si.tick_size):
            raise Rejected([f"TP {new_tp} is not on the {si.tick_size} tick grid."])
        pos = next((x for x in self.gw.positions(self.cfg.magic) if x.identifier == ticket), None)
        if pos:
            res = self._set_position_tp(order, pos, new_tp, tick, si, "TP change requested")
            if not res:
                raise Rejected(["MT5 refused the TP change; the position keeps its previous TP."])
            return {"order_id": order["id"], "target": "position", "take_profit": new_tp, "stop_loss": pos.sl}
        pend = next((o for o in self.gw.orders(self.cfg.magic) if o.ticket == ticket), None)
        if not pend:
            raise Rejected(["Neither a pending order nor an open position exists for this order."])
        bad = (order["direction"] == "BUY" and new_tp <= pend.price_open) or (order["direction"] == "SELL" and new_tp >= pend.price_open)
        if bad:
            raise Rejected(["TP is on the wrong side of the entry."])
        res = self.gw.send({"action": "modify", "order": ticket, "price": pend.price_open, "sl": pend.sl, "tp": new_tp})
        if not res.ok:
            raise Rejected([f"MT5 refused the TP change ({res.retcode}: {res.comment})."])
        self.db.update_order(order["id"], {"take_profit": new_tp})
        self._event("tp_modified", {"ticket": ticket, "take_profit": new_tp, "stop_loss": pend.sl}, order["id"])
        return {"order_id": order["id"], "target": "order", "take_profit": new_tp, "stop_loss": pend.sl}

    def _set_position_tp(self, order: Row, pos: Mt5Position, new_tp: float, tick, si, why: str, new_sl: float | None = None) -> bool:
        sl = pos.sl if new_sl is None else new_sl
        side_ok = (pos.type == "BUY" and new_tp > tick.bid) or (pos.type == "SELL" and new_tp < tick.ask)
        res = self.gw.send({"action": "sltp", "position": pos.ticket, "symbol": pos.symbol, "sl": sl, "tp": new_tp}) if side_ok else None
        ok = bool(res and res.ok)
        reason = None if ok else ("TP is on the wrong side of the market" if not side_ok else f"MT5 {res.retcode}: {res.comment}")
        self.db.upsert_position({
            **self._position_row(order, pos),
            "stop_loss": sl if ok else pos.sl, "take_profit": new_tp if ok else pos.tp,
            "tp_modification_state": "confirmed" if ok else "failed", "tp_modification_requested": new_tp,
            "tp_modification_reason": reason,
        })
        self._event("tp_modified" if ok else "tp_modify_failed", {"why": why, "ticket": pos.ticket, "take_profit": new_tp, "stop_loss": sl, "reason": reason}, order["id"])
        return ok

    def _emergency(self, cmd: Row) -> Row:
        if cmd["user_id"] != (self._account or {}).get("user_id"):
            raise Rejected(["Command owner does not match the account owner."])
        self.db.set_emergency(cmd["user_id"])
        cancelled, failed = 0, 0
        by_ticket = {int(o["provider_order_id"]): o for o in self.db.get_orders(self.cfg.account_id) if o.get("provider_order_id")}
        for o in self.gw.orders(self.cfg.magic):
            res = self.gw.send({"action": "remove", "order": o.ticket})
            if res.ok:
                cancelled += 1
                if o.ticket in by_ticket:
                    self.db.update_order(by_ticket[o.ticket]["id"], {"state": "cancelled"})
            else:
                failed += 1
        self._event("emergency_disable", {"cancelled": cancelled, "failed": failed})
        return {"cancelled": cancelled, "failed": failed, "note": "Open positions keep their SL/TP."}

    # ------------------------------------------------------------------ reconciliation
    def _position_row(self, order: Row, pos: Mt5Position) -> Row:
        return {
            "order_id": order["id"], "user_id": order["user_id"], "signal_id": order["signal_id"], "account_id": order["account_id"],
            "symbol": order["symbol"], "direction": order["direction"], "volume": pos.volume, "entry_price": pos.price_open,
            "stop_loss": pos.sl, "take_profit": pos.tp, "status": "open", "simulated": False, "opened_at": self.now().isoformat(),
        }

    def reconcile(self) -> None:
        orders = self.db.get_orders(self.cfg.account_id)
        if not orders:
            return
        mt5_orders = {o.ticket: o for o in self.gw.orders(self.cfg.magic)}
        positions = {p.identifier: p for p in self.gw.positions(self.cfg.magic)}
        deals = self.gw.deals_since(self.now() - timedelta(days=7), self.cfg.magic)
        for o in orders:
            ticket = int(o["provider_order_id"]) if o.get("provider_order_id") else None
            if ticket is None and o["state"] == "unknown":
                # Recover an order whose send outcome was unknown, via its comment tag.
                tag = order_tag(o["client_order_id"])
                hit = next((x.ticket for x in mt5_orders.values() if x.comment == tag), None) \
                    or next((p.identifier for p in positions.values() if p.comment == tag), None) \
                    or next((d.order for d in deals if d.comment == tag and d.entry in ("in", "inout")), None)
                if hit is None:
                    continue
                ticket = hit
                self.db.update_order(o["id"], {"provider_order_id": str(ticket)})
                self._event("unknown_resolved", {"ticket": ticket}, o["id"])
            if ticket is None:
                continue
            self._reconcile_order(o, ticket, mt5_orders.get(ticket), positions.get(ticket), [d for d in deals if d.order == ticket or d.position_id == ticket])

    def _reconcile_order(self, o: Row, ticket: int, active, pos: Mt5Position | None, deals) -> None:
        entry_deals = [d for d in deals if d.order == ticket and d.entry in ("in", "inout")]
        for d in entry_deals:
            self.db.insert_fill({"order_id": o["id"], "user_id": o["user_id"], "provider_fill_id": str(d.ticket), "price": d.price,
                                 "volume": d.volume, "filled_at": d.time.isoformat(), "simulated": False})
        filled = float(sum(Decimal(str(d.volume)) for d in entry_deals))
        if active:
            state = "partially_filled" if filled > 0 else "acknowledged"
        else:
            hist = self.gw.history_order(ticket)
            if hist and hist.state in ("canceled", "expired", "rejected"):
                state = {"canceled": "cancelled", "expired": "expired", "rejected": "rejected"}[hist.state]
            elif filled > 0 or pos or (hist and hist.state == "filled"):
                state = "filled"
            else:
                state = o["state"]
        patch: Row = {}
        if filled != float(o.get("filled_volume") or 0):
            patch["filled_volume"] = filled
        if state != o["state"] and o["state"] not in TERMINAL:
            patch["state"] = state
        if patch:
            self.db.update_order(o["id"], patch)
            self._event("order_state", {"ticket": ticket, **patch}, o["id"])

        existing = self.db.get_position(o["id"])
        if pos:
            if not existing:
                self.db.upsert_position(self._position_row(o, pos))
                self._event("position_opened", {"ticket": pos.ticket, "entry": pos.price_open, "volume": pos.volume}, o["id"])
                existing = {"tp_modification_state": "none"}
            self._rebase_levels(o, pos, existing)
        elif existing and existing.get("status") == "open":
            out = next((d for d in deals if d.position_id == ticket and d.entry in ("out", "out_by")), None)
            self.db.upsert_position({**existing, "status": "closed", "close_price": out.price if out else None,
                                     "closed_at": (out.time if out else self.now()).isoformat()})
            self._event("position_closed", {"ticket": ticket, "close_price": out.price if out else None}, o["id"])

    def _rebase_levels(self, o: Row, pos: Mt5Position, existing: Row) -> None:
        """SL from the ACTUAL entry; TP per the signal's current mode (default or extended)."""
        signal = self.db.get_signal(o["signal_id"])
        broker_sym = self.cfg.symbol_map.get(o["symbol"])
        si = self.gw.symbol_info(broker_sym) if broker_sym else None
        if not signal or not si:
            return
        sl = rules.stop_loss(o["direction"], pos.price_open, float(signal["stop_loss_distance"]), si.tick_size)
        tp = rules.take_profit_for(o["direction"], pos.price_open, signal, si.tick_size)
        half = si.tick_size / 2
        if abs(pos.sl - sl) <= half and abs(pos.tp - tp) <= half:
            if existing.get("take_profit") != pos.tp or existing.get("stop_loss") != pos.sl:
                self.db.upsert_position({**self._position_row(o, pos), "tp_modification_state": existing.get("tp_modification_state", "none")})
            return
        if existing.get("tp_modification_state") == "failed" and existing.get("tp_modification_requested") == tp:
            return  # already failed for this target; shown to the user, not retried in a loop
        tick = self.gw.tick(broker_sym)
        if tick:
            self._set_position_tp(o, pos, tp, tick, si, "Re-based on actual fill price", new_sl=sl)
