"""MT5 gateway (magic=None lists everything on the account, including manual trades): a thin, typed wrapper over the official `MetaTrader5` Python package.

The package only works on Windows next to an installed, running MT5 terminal. The engine
talks to the `Mt5Gateway` protocol so it can be tested with a fake on any OS.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

# MT5 trade return codes that mean the request was accepted.
RETCODE_DONE = 10009
RETCODE_PLACED = 10008
RETCODE_DONE_PARTIAL = 10010
OK_RETCODES = {RETCODE_DONE, RETCODE_PLACED, RETCODE_DONE_PARTIAL}


@dataclass
class AccountInfo:
    login: int
    server: str
    balance: float
    equity: float
    currency: str
    trade_mode: str  # demo | contest | real | unknown
    trade_allowed: bool


@dataclass
class SymbolInfo:
    tick_size: float
    tick_value: float  # per 1.0 lot per tick, in deposit currency
    point: float
    digits: int
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level_points: int
    trade_enabled: bool


@dataclass
class Tick:
    bid: float
    ask: float
    time: datetime


@dataclass
class Mt5Order:
    ticket: int
    symbol: str
    type: str  # BUY_LIMIT | SELL_LIMIT | ...
    volume_initial: float
    volume_current: float
    price_open: float
    sl: float
    tp: float
    comment: str


@dataclass
class Mt5Position:
    ticket: int
    identifier: int  # ticket of the order that opened it
    symbol: str
    type: str  # BUY | SELL
    volume: float
    price_open: float
    sl: float
    tp: float
    comment: str


@dataclass
class Mt5Deal:
    ticket: int
    order: int
    position_id: int
    entry: str  # in | out | inout | out_by
    price: float
    volume: float
    profit: float
    commission: float
    swap: float
    time: datetime
    comment: str


@dataclass
class HistoryOrder:
    ticket: int
    state: str  # filled | canceled | expired | rejected | partial | placed | started | unknown
    volume_initial: float
    volume_current: float


@dataclass
class SendResult:
    retcode: int
    comment: str
    order: int
    deal: int

    @property
    def ok(self) -> bool:
        return self.retcode in OK_RETCODES


class Mt5Gateway(Protocol):
    def connect(self) -> bool: ...
    def last_error(self) -> str: ...
    def account_info(self) -> AccountInfo | None: ...
    def symbol_info(self, symbol: str) -> SymbolInfo | None: ...
    def tick(self, symbol: str) -> Tick | None: ...
    def orders(self, magic: int | None) -> list[Mt5Order]: ...
    def positions(self, magic: int | None) -> list[Mt5Position]: ...
    def deals_since(self, since: datetime, magic: int | None) -> list[Mt5Deal]: ...
    def history_order(self, ticket: int) -> HistoryOrder | None: ...
    def send(self, request: dict[str, Any]) -> SendResult: ...


class RealMt5Gateway:
    """Implementation over the MetaTrader5 package (Windows only)."""

    def __init__(self, terminal_path: str, login: int, server: str, password: str | None):
        import MetaTrader5 as mt5  # noqa: N813 - official module name

        self.mt5 = mt5
        self.terminal_path = terminal_path
        self.login = login
        self.server = server
        self._password = password

    def connect(self) -> bool:
        m = self.mt5
        if m.terminal_info() is not None and m.account_info() is not None:
            return True
        kwargs: dict[str, Any] = {"path": self.terminal_path, "login": self.login, "server": self.server, "timeout": 30000}
        if self._password:
            kwargs["password"] = self._password
        return bool(m.initialize(**kwargs))

    def last_error(self) -> str:
        code, msg = self.mt5.last_error()
        return f"{code}: {msg}"

    def account_info(self) -> AccountInfo | None:
        a = self.mt5.account_info()
        if a is None:
            return None
        modes = {self.mt5.ACCOUNT_TRADE_MODE_DEMO: "demo", self.mt5.ACCOUNT_TRADE_MODE_CONTEST: "contest", self.mt5.ACCOUNT_TRADE_MODE_REAL: "real"}
        t = self.mt5.terminal_info()
        return AccountInfo(
            login=a.login,
            server=a.server,
            balance=a.balance,
            equity=a.equity,
            currency=a.currency,
            trade_mode=modes.get(a.trade_mode, "unknown"),
            trade_allowed=bool(a.trade_allowed and a.trade_expert and t is not None and t.trade_allowed),
        )

    def symbol_info(self, symbol: str) -> SymbolInfo | None:
        if not self.mt5.symbol_select(symbol, True):
            return None
        s = self.mt5.symbol_info(symbol)
        if s is None:
            return None
        return SymbolInfo(
            tick_size=s.trade_tick_size,
            tick_value=s.trade_tick_value,
            point=s.point,
            digits=s.digits,
            volume_min=s.volume_min,
            volume_max=s.volume_max,
            volume_step=s.volume_step,
            stops_level_points=s.trade_stops_level,
            trade_enabled=s.trade_mode == self.mt5.SYMBOL_TRADE_MODE_FULL,
        )

    def tick(self, symbol: str) -> Tick | None:
        t = self.mt5.symbol_info_tick(symbol)
        if t is None:
            return None
        return Tick(bid=t.bid, ask=t.ask, time=datetime.fromtimestamp(t.time, tz=_UTC))

    def _otype(self, t: int) -> str:
        m = self.mt5
        return {
            m.ORDER_TYPE_BUY: "BUY",
            m.ORDER_TYPE_SELL: "SELL",
            m.ORDER_TYPE_BUY_LIMIT: "BUY_LIMIT",
            m.ORDER_TYPE_SELL_LIMIT: "SELL_LIMIT",
        }.get(t, "OTHER")

    def orders(self, magic: int | None) -> list[Mt5Order]:
        return [
            Mt5Order(o.ticket, o.symbol, self._otype(o.type), o.volume_initial, o.volume_current, o.price_open, o.sl, o.tp, o.comment)
            for o in (self.mt5.orders_get() or ())
            if magic is None or o.magic == magic
        ]

    def positions(self, magic: int | None) -> list[Mt5Position]:
        m = self.mt5
        return [
            Mt5Position(p.ticket, p.identifier, p.symbol, "BUY" if p.type == m.POSITION_TYPE_BUY else "SELL", p.volume, p.price_open, p.sl, p.tp, p.comment)
            for p in (m.positions_get() or ())
            if magic is None or p.magic == magic
        ]

    def deals_since(self, since: datetime, magic: int | None) -> list[Mt5Deal]:
        m = self.mt5
        entries = {m.DEAL_ENTRY_IN: "in", m.DEAL_ENTRY_OUT: "out", m.DEAL_ENTRY_INOUT: "inout", m.DEAL_ENTRY_OUT_BY: "out_by"}
        return [
            Mt5Deal(d.ticket, d.order, d.position_id, entries.get(d.entry, "unknown"), d.price, d.volume, d.profit, d.commission, d.swap,
                    datetime.fromtimestamp(d.time, tz=_UTC), d.comment)
            for d in (m.history_deals_get(since, datetime.now(tz=_UTC)) or ())
            if magic is None or d.magic == magic
        ]

    def history_order(self, ticket: int) -> HistoryOrder | None:
        m = self.mt5
        found = m.history_orders_get(ticket=ticket)
        if not found:
            return None
        o = found[0]
        states = {
            m.ORDER_STATE_FILLED: "filled",
            m.ORDER_STATE_CANCELED: "canceled",
            m.ORDER_STATE_EXPIRED: "expired",
            m.ORDER_STATE_REJECTED: "rejected",
            m.ORDER_STATE_PARTIAL: "partial",
            m.ORDER_STATE_PLACED: "placed",
            m.ORDER_STATE_STARTED: "started",
        }
        return HistoryOrder(o.ticket, states.get(o.state, "unknown"), o.volume_initial, o.volume_current)

    def send(self, request: dict[str, Any]) -> SendResult:
        m = self.mt5
        actions = {"deal": m.TRADE_ACTION_DEAL, "pending": m.TRADE_ACTION_PENDING, "sltp": m.TRADE_ACTION_SLTP,
                   "modify": m.TRADE_ACTION_MODIFY, "remove": m.TRADE_ACTION_REMOVE}
        types = {"BUY": m.ORDER_TYPE_BUY, "SELL": m.ORDER_TYPE_SELL, "BUY_LIMIT": m.ORDER_TYPE_BUY_LIMIT, "SELL_LIMIT": m.ORDER_TYPE_SELL_LIMIT}
        req = dict(request)
        req["action"] = actions[req["action"]]
        if "type" in req:
            req["type"] = types[req["type"]]
        if req["action"] in (m.TRADE_ACTION_DEAL, m.TRADE_ACTION_PENDING):
            req.setdefault("type_time", m.ORDER_TIME_GTC)
            req.setdefault("type_filling", m.ORDER_FILLING_RETURN if req["action"] == m.TRADE_ACTION_PENDING else m.ORDER_FILLING_IOC)
        r = m.order_send(req)
        if r is None:
            return SendResult(-1, self.last_error(), 0, 0)
        return SendResult(r.retcode, r.comment, r.order, r.deal)


from datetime import timezone as _tz  # noqa: E402

_UTC = _tz.utc
