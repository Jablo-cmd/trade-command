from datetime import timedelta

import pytest

from tradecommand_connector.engine import Engine, EngineConfig, order_tag
from tests.fakes import ACCOUNT, NOW, SIGNAL, USER, FakeDb, FakeMt5

LIMIT_B = {"group_id": "grp-B", "symbol": "XAUUSD", "direction": "BUY", "order_kind": "limit",
           "entry": 4077, "stop_loss": 4062, "take_profit": 4080, "volume": 0.33}


def make(trade_mode="demo", **cfg):
    db, mt5 = FakeDb(), FakeMt5(trade_mode=trade_mode)
    eng = Engine(EngineConfig("vps-test", ACCOUNT, 111, "FTMO-Demo", **cfg), db, mt5, now=lambda: NOW)
    return eng, db, mt5


def run(eng):
    eng.run_once()


def submit(db, cid="s1:B:acc-1", **over):
    return db.queue("submit", cid, {**LIMIT_B, **over})


def reasons(cmd):
    return " | ".join(cmd["result"]["reasons"])


# ---------------------------------------------------------------- heartbeat
def test_heartbeat_reports_connection_and_quotes():
    eng, db, mt5 = make()
    run(eng)
    hb = db.heartbeats[ACCOUNT]
    assert hb["login_verified"] and hb["trade_mode"] == "demo"
    assert hb["quotes"]["XAUUSD"] == {"bid": 4080.3, "ask": 4080.5, "time": NOW.isoformat()}
    assert db.accounts[ACCOUNT]["connection_status"] == "connected"


def test_wrong_login_is_unauthorized_and_processes_nothing():
    eng, db, mt5 = make()
    mt5.info.login = 999
    cmd = submit(db)
    run(eng)
    assert db.accounts[ACCOUNT]["connection_status"] == "unauthorized"
    assert cmd["status"] == "pending" and mt5.sent == []


def test_disconnected_terminal():
    eng, db, mt5 = make()
    mt5.connected = False
    run(eng)
    assert db.accounts[ACCOUNT]["connection_status"] == "disconnected"
    assert "no IPC" in db.heartbeats[ACCOUNT]["error"]


# ---------------------------------------------------------------- submit: happy path
def test_submit_places_limit_with_recomputed_levels_and_tag():
    eng, db, mt5 = make()
    cmd = submit(db)
    run(eng)
    assert cmd["status"] == "done", cmd.get("result")
    req = mt5.sent[0]
    assert req["action"] == "pending" and req["type"] == "BUY_LIMIT"
    assert (req["price"], req["sl"], req["tp"], req["volume"]) == (4077, 4062.0, 4080.0, 0.33)
    assert req["comment"] == order_tag("s1:B:acc-1") and len(req["comment"]) <= 31
    order = next(iter(db.orders.values()))
    assert order["state"] == "acknowledged" and order["simulated"] is False and order["provider_name"] == "MT5 connector (demo)"


# ---------------------------------------------------------------- submit: safety checks
@pytest.mark.parametrize("mutate, expected", [
    (lambda db, mt5: db.accounts[ACCOUNT].update(trading_enabled=False), "Trading is disabled"),
    (lambda db, mt5: db.accounts[ACCOUNT].update(execution_mode="simulation"), "not 'live_automated'"),
    (lambda db, mt5: db.accounts[ACCOUNT].update(compatibility_profile_id=None), "No prop-firm compatibility profile"),
    (lambda db, mt5: db.items.__setitem__(0, {**db.items[0], "status": "unknown"}), "automatedExecution: unknown"),
    (lambda db, mt5: db.items.__setitem__(1, {**db.items[1], "source": None}), "eaOrApi: permitted without source"),
    (lambda db, mt5: db.emergency.add(USER), "Emergency disable is active"),
    (lambda db, mt5: setattr(mt5.info, "trade_allowed", False), "Algo trading is disabled"),
    (lambda db, mt5: db.signals[SIGNAL].update(status="closed"), "Signal is closed"),
    (lambda db, mt5: db.risk[ACCOUNT].pop("max_risk_per_trade"), "Maximum risk per trade is not configured"),
    (lambda db, mt5: setattr(mt5.quote, "time", NOW - timedelta(minutes=5)), "No fresh XAUUSD quote"),
])
def test_submit_rejections(mutate, expected):
    eng, db, mt5 = make()
    mutate(db, mt5)
    cmd = submit(db)
    run(eng)
    assert cmd["status"] == "rejected"
    assert expected in reasons(cmd)
    assert not any(r["action"] in ("pending", "deal") for r in mt5.sent)
    assert db.orders == {}


def test_real_account_refused_unless_config_allows():
    eng, db, mt5 = make(trade_mode="real")
    cmd = submit(db)
    run(eng)
    assert cmd["status"] == "rejected" and "REAL-money" in reasons(cmd)
    eng2, db2, mt52 = make(trade_mode="real", allow_real_accounts=True)
    cmd2 = submit(db2)
    run(eng2)
    assert cmd2["status"] == "done"


def test_stale_command_rejected():
    eng, db, mt5 = make()
    cmd = db.queue("submit", "old", LIMIT_B, created_at=NOW - timedelta(minutes=5))
    run(eng)
    assert "older than 120s" in reasons(cmd)


def test_other_users_command_rejected():
    eng, db, mt5 = make()
    cmd = db.queue("submit", "x", LIMIT_B, user="intruder")
    run(eng)
    assert "owner does not match" in reasons(cmd)


def test_tampered_levels_rejected():
    eng, db, mt5 = make()
    cmd = submit(db, stop_loss=4050)
    run(eng)
    assert "do not match the strategy" in reasons(cmd)


def test_limit_at_or_above_ask_rejected():
    eng, db, mt5 = make()
    cmd = submit(db, entry=4080.5, stop_loss=4065.5, take_profit=4083.5)
    run(eng)
    assert "must be below ask" in reasons(cmd)


def test_volume_above_risk_budget_rejected_not_reduced():
    eng, db, mt5 = make()
    cmd = submit(db, volume=0.5)
    run(eng)
    assert "exceeds the 0.33 lots allowed" in reasons(cmd)


def test_existing_exposure_and_aggregate_cap():
    eng, db, mt5 = make()
    db.risk[ACCOUNT]["max_aggregate_risk"] = 600
    run(eng)
    submit(db, "first")
    run(eng)  # first order reserves 495 of 600
    cmd = submit(db, "second", entry=4075, stop_loss=4060, take_profit=4078, volume=0.1)
    run(eng)
    assert "exceeds the 0.07 lots allowed" in reasons(cmd)


def test_unprotected_manual_position_blocks_new_orders():
    eng, db, mt5 = make()
    from tradecommand_connector.gateway import Mt5Position
    mt5._positions[1] = Mt5Position(1, 1, "XAUUSD", "BUY", 1.0, 4070, 0.0, 0.0, "manual")
    cmd = submit(db)
    run(eng)
    assert "has no stop-loss" in reasons(cmd)


def test_daily_loss_limit_uses_realized_and_floating():
    eng, db, mt5 = make()
    db.risk[ACCOUNT].update(daily_loss_limit=1000)
    mt5.info.equity = 99300  # 700 floating loss
    cmd = submit(db)
    run(eng)
    # 1000 - 700 = 300 budget -> 0.2 lots allowed
    assert "exceeds the 0.2 lots allowed" in reasons(cmd)


def test_broker_rejection_recorded():
    eng, db, mt5 = make()
    mt5.fail_next = (10019, "No money")
    cmd = submit(db)
    run(eng)
    assert cmd["status"] == "rejected" and "10019" in reasons(cmd)
    assert next(iter(db.orders.values()))["state"] == "rejected"


# ---------------------------------------------------------------- idempotency
def test_duplicate_submit_never_sends_twice():
    eng, db, mt5 = make()
    submit(db)
    run(eng)
    db.commands.clear()
    again = submit(db)
    run(eng)
    assert again["status"] == "done" and again["result"]["duplicate"] is True
    assert len([r for r in mt5.sent if r["action"] == "pending"]) == 1


def test_unknown_send_outcome_is_not_retried_and_is_recovered_by_tag():
    eng, db, mt5 = make()
    mt5.raise_next = True
    cmd = submit(db)
    run(eng)
    order = next(iter(db.orders.values()))
    assert cmd["status"] == "done" and cmd["result"]["state"] == "unknown"
    assert order["provider_order_id"] is not None  # reconciliation found it via the comment tag
    assert len([r for r in mt5.sent if r["action"] == "pending"]) == 1


# ---------------------------------------------------------------- lifecycle
def place(eng, db, mt5, cid="s1:B:acc-1", **over):
    submit(db, cid, **over)
    run(eng)
    order = next(o for o in db.orders.values() if o["client_order_id"] == cid)
    return order, int(order["provider_order_id"])


def test_fill_at_limit_creates_position_without_modification():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077)
    run(eng)
    assert db.orders[order["id"]]["state"] == "filled"
    pos = db.positions[order["id"]]
    assert (pos["entry_price"], pos["stop_loss"], pos["take_profit"], pos["status"]) == (4077, 4062.0, 4080.0, "open")
    assert not any(r["action"] == "sltp" for r in mt5.sent)


def test_gap_fill_rebases_sl_and_tp_on_actual_entry():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4076.4)
    run(eng)
    sltp = [r for r in mt5.sent if r["action"] == "sltp"]
    assert sltp and (sltp[-1]["sl"], sltp[-1]["tp"]) == (4061.4, 4079.4)
    pos = db.positions[order["id"]]
    assert (pos["stop_loss"], pos["take_profit"], pos["tp_modification_state"]) == (4061.4, 4079.4, "confirmed")


def test_partial_then_full_fill_with_vwap():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077, 0.16)
    run(eng)
    assert db.orders[order["id"]]["state"] == "partially_filled"
    assert db.orders[order["id"]]["filled_volume"] == 0.16
    mt5.fill_pending(ticket, 4076, 0.17)
    run(eng)
    assert db.orders[order["id"]]["state"] == "filled"
    assert len(db.fills) == 2
    pos = db.positions[order["id"]]
    assert pos["volume"] == 0.33 and pos["entry_price"] == 4076.48
    assert (pos["stop_loss"], pos["take_profit"]) == (4061.48, 4079.48)


def test_failed_rebase_is_recorded_and_not_retried_every_cycle():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fail_sltp = True
    mt5.fill_pending(ticket, 4076.4)
    run(eng)
    run(eng)
    assert db.positions[order["id"]]["tp_modification_state"] == "failed"
    assert len([r for r in mt5.sent if r["action"] == "sltp"]) == 1


def test_position_close_recorded():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077)
    run(eng)
    mt5.close_position(ticket, 4080)
    run(eng)
    pos = db.positions[order["id"]]
    assert pos["status"] == "closed" and pos["close_price"] == 4080


def test_cancel_pending():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    cmd = db.queue("cancel", order["client_order_id"])
    run(eng)
    assert cmd["status"] == "done" and db.orders[order["id"]]["state"] == "cancelled"
    assert mt5.orders(None) == []


def test_cancel_after_fill_is_rejected_with_reason():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077)
    run(eng)
    cmd = db.queue("cancel", order["client_order_id"])
    run(eng)
    assert cmd["status"] == "rejected" and "no longer pending" in reasons(cmd)


def test_extended_tp_on_position_keeps_stop_loss():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077)
    run(eng)
    db.signals[SIGNAL].update(tp_mode="extended_absolute", extended_tp_price=4149)
    cmd = db.queue("modify_tp", order["client_order_id"], {"take_profit": 4149})
    run(eng)
    assert cmd["status"] == "done", cmd.get("result")
    pos = db.positions[order["id"]]
    assert (pos["take_profit"], pos["stop_loss"], pos["tp_modification_state"]) == (4149, 4062.0, "confirmed")
    # Next reconcile keeps the extended target instead of reverting to the default TP.
    run(eng)
    assert db.positions[order["id"]]["take_profit"] == 4149


def test_extended_tp_on_pending_order():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    cmd = db.queue("modify_tp", order["client_order_id"], {"take_profit": 4149})
    run(eng)
    assert cmd["status"] == "done"
    assert mt5.orders(None)[0].tp == 4149 and mt5.orders(None)[0].sl == 4062.0


def test_failed_tp_change_keeps_old_tp():
    eng, db, mt5 = make()
    order, ticket = place(eng, db, mt5)
    mt5.fill_pending(ticket, 4077)
    run(eng)
    mt5.fail_sltp = True
    cmd = db.queue("modify_tp", order["client_order_id"], {"take_profit": 4149})
    run(eng)
    assert cmd["status"] == "rejected"
    pos = db.positions[order["id"]]
    assert (pos["take_profit"], pos["tp_modification_state"]) == (4080.0, "failed")


def test_emergency_disable_cancels_pending_and_blocks_new_orders():
    eng, db, mt5 = make()
    place(eng, db, mt5, "a")
    place(eng, db, mt5, "b", entry=4075, stop_loss=4060, take_profit=4078, volume=0.01)
    cmd = db.queue("emergency_disable")
    run(eng)
    assert cmd["status"] == "done" and cmd["result"]["cancelled"] == 2
    assert all(o["state"] == "cancelled" for o in db.orders.values())
    blocked = submit(db, "c", volume=0.01)
    run(eng)
    assert "Emergency disable is active" in reasons(blocked)


def test_market_entry_uses_live_price():
    eng, db, mt5 = make()
    cmd = submit(db, "m", order_kind="market", entry=4080, stop_loss=4065, take_profit=4083, volume=0.33)
    run(eng)
    assert cmd["status"] == "done", cmd.get("result")
    order = next(iter(db.orders.values()))
    assert (order["limit_price"], order["stop_loss"], order["take_profit"]) == (4080.5, 4065.5, 4083.5)
    assert db.orders[order["id"]]["state"] == "filled"


def test_config_rejects_inline_secrets(tmp_path):
    from tradecommand_connector.config import load_config
    p = tmp_path / "c.json"
    p.write_text('{"connector_id":"x","supabase_url":"u","service_role_key":"abc","account":{}}')
    with pytest.raises(ValueError, match="looks like a secret"):
        load_config(p)
