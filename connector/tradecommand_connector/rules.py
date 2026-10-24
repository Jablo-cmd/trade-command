"""Pure trading rules, mirroring src/domain (strategy.ts, risk.ts, compatibility.ts).

Decimal arithmetic keeps tick and volume rounding exact. The shared vectors in
src/domain/__vectors__/strategy-risk.json are run by both the app and this module.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal

COMPATIBILITY_ITEMS = (
    "automatedExecution",
    "eaOrApi",
    "vpsVpn",
    "personalAccountCopying",
    "pendingOrders",
    "hedgingNetting",
    "instrumentRestrictions",
    "newsSessionRestrictions",
    "programLimitations",
)


def D(x: float | int | str | Decimal) -> Decimal:
    return x if isinstance(x, Decimal) else Decimal(str(x))


def on_tick(price: float, tick: float) -> bool:
    q = D(price) / D(tick)
    return q == q.to_integral_value()


def round_to_tick(price: float | Decimal, tick: float) -> float:
    t = D(tick)
    return float((D(price) / t).to_integral_value(ROUND_HALF_UP) * t)


def floor_to_step(volume: float | Decimal, step: float) -> float:
    s = D(step)
    return float((D(volume) / s).to_integral_value(ROUND_FLOOR) * s)


def stop_loss(direction: str, entry: float, distance: float, tick: float) -> float:
    d = D(distance) if direction == "BUY" else -D(distance)
    return round_to_tick(D(entry) - d, tick)


def default_take_profit(direction: str, entry: float, tp_pips: float, pip_size: float, tick: float) -> float:
    dist = D(tp_pips) * D(pip_size)
    return round_to_tick(D(entry) + (dist if direction == "BUY" else -dist), tick)


def take_profit_for(direction: str, entry: float, signal: dict, tick: float) -> float:
    """Active TP for a position under its signal's TP mode (extended = shared absolute price)."""
    if signal.get("tp_mode") == "extended_absolute":
        return float(signal["extended_tp_price"])
    return default_take_profit(direction, entry, float(signal["default_tp_pips"]), float(signal["strategy_pip_size"]), tick)


def loss_at_stop(entry: float, sl: float, volume: float, tick_size: float, tick_value: float) -> Decimal:
    """Monetary loss at the stop. MT5's trade_tick_value is already in the deposit currency."""
    ticks = abs(D(entry) - D(sl)) / D(tick_size)
    return ticks * D(tick_value) * D(volume)


@dataclass
class Sizing:
    volume: float
    risk: float
    risk_per_lot: float
    reasons: list[str] = field(default_factory=list)


def size_position(
    budget: float,
    entry: float,
    sl: float,
    tick_size: float,
    tick_value: float,
    vmin: float,
    vmax: float,
    vstep: float,
    commission_per_lot: float = 0.0,
    max_volume: float | None = None,
) -> Sizing:
    """Largest volume within budget, rounded DOWN. Never raises risk to reach vmin."""
    per_lot = loss_at_stop(entry, sl, 1, tick_size, tick_value) + D(commission_per_lot)
    if per_lot <= 0:
        return Sizing(0, 0, 0, ["Entry and stop-loss must differ."])
    if D(budget) <= 0:
        return Sizing(0, 0, float(per_lot), ["No risk budget remaining under the configured limits."])
    volume = D(floor_to_step(D(budget) / per_lot, vstep))
    cap = min(D(vmax), D(max_volume) if max_volume is not None else D(vmax))
    if volume > cap:
        volume = D(floor_to_step(cap, vstep))
    if volume < D(vmin):
        min_risk = (per_lot * D(vmin)).quantize(Decimal("0.01"))
        return Sizing(0, 0, float(per_lot), [f"Minimum volume {vmin} would risk {min_risk}, above the budget {budget:.2f}."])
    risk = (per_lot * volume).quantize(Decimal("0.01"), ROUND_HALF_UP)
    return Sizing(float(volume), float(risk), float(per_lot))


def compatibility_blockers(items: list[dict], uses_pending_orders: bool) -> list[str]:
    """Live automation requires every relevant rule to be permitted/conditional WITH evidence."""
    by_key = {i["item_key"]: i for i in items}
    blockers = []
    for key in COMPATIBILITY_ITEMS:
        if key == "pendingOrders" and not uses_pending_orders:
            continue
        item = by_key.get(key, {"status": "unknown"})
        status = item.get("status", "unknown")
        if status in ("unknown", "prohibited"):
            blockers.append(f"{key}: {status}")
        elif not item.get("source") or not item.get("verified_on"):
            blockers.append(f"{key}: {status} without source and verification date")
    return blockers


def validate_levels(
    direction: str,
    order_kind: str,
    entry: float,
    sl: float,
    tp: float,
    bid: float,
    ask: float,
    tick: float,
    min_distance: float,
) -> list[str]:
    errors = []
    for label, v in (("entry", entry), ("stop-loss", sl), ("take-profit", tp)):
        if not on_tick(v, tick):
            errors.append(f"{label} {v} is not on the {tick} tick grid")
    if direction == "BUY":
        if not sl < entry < tp:
            errors.append("BUY needs stop-loss < entry < take-profit")
    elif not tp < entry < sl:
        errors.append("SELL needs take-profit < entry < stop-loss")
    md = D(min_distance)
    if md > 0:
        if abs(D(entry) - D(sl)) < md:
            errors.append(f"stop-loss closer than broker minimum {min_distance}")
        if abs(D(tp) - D(entry)) < md:
            errors.append(f"take-profit closer than broker minimum {min_distance}")
    if order_kind == "limit":
        if direction == "BUY":
            if entry >= ask:
                errors.append(f"BUY LIMIT {entry} must be below ask {ask}")
            elif D(ask) - D(entry) < md:
                errors.append("BUY LIMIT closer to market than broker minimum")
        else:
            if entry <= bid:
                errors.append(f"SELL LIMIT {entry} must be above bid {bid}")
            elif D(entry) - D(bid) < md:
                errors.append("SELL LIMIT closer to market than broker minimum")
    return errors
