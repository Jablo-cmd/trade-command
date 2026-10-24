"""Run: python -m tradecommand_connector --config accounts\\ftmo-demo-1.json"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
import time

from .config import load_config, read_secret
from .db import SupabaseRest
from .engine import Engine


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="tradecommand_connector")
    ap.add_argument("--config", required=True, help="Path to this account's JSON config")
    ap.add_argument("--once", action="store_true", help="Run one cycle (heartbeat, commands, reconcile) and exit")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    key = read_secret(cfg.service_key_env)
    if not key:
        logging.error("Supabase service key not found in env var or credential store '%s'.", cfg.service_key_env)
        return 2

    from .gateway import RealMt5Gateway  # imported here: MetaTrader5 is Windows-only

    gw = RealMt5Gateway(cfg.terminal_path, cfg.engine.mt5_login, cfg.engine.mt5_server, read_secret(cfg.password_env))
    engine = Engine(cfg.engine, SupabaseRest(cfg.supabase_url, key), gw)
    logging.info("Connector %s started for account %s (login %s @ %s). Real accounts allowed: %s",
                 cfg.engine.connector_id, cfg.engine.account_id, cfg.engine.mt5_login, cfg.engine.mt5_server, cfg.engine.allow_real_accounts)

    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    while not stop:
        try:
            engine.run_once()
        except Exception:
            logging.exception("cycle failed; retrying")
        if args.once:
            break
        time.sleep(cfg.poll_seconds)
    logging.info("Connector stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
