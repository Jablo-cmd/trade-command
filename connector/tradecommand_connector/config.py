"""Connector configuration.

The JSON config holds no secrets. The Supabase service-role key and the optional MT5
password are read from environment variables or the OS credential store (Windows
Credential Manager via `keyring`), named in the config.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .engine import EngineConfig

SECRET_HINT = ("password", "secret", "service_role", "api_key", "token")


@dataclass
class ConnectorConfig:
    engine: EngineConfig
    supabase_url: str
    service_key_env: str
    terminal_path: str
    password_env: str | None
    poll_seconds: float


def load_config(path: str | Path) -> ConnectorConfig:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    _reject_inline_secrets(raw)
    acc = raw["account"]
    engine = EngineConfig(
        connector_id=raw["connector_id"],
        account_id=acc["trading_account_id"],
        mt5_login=int(acc["mt5_login"]),
        mt5_server=acc["mt5_server"],
        symbol_map=acc.get("symbols", {"XAUUSD": "XAUUSD"}),
        magic=int(raw.get("magic", 7031001)),
        allow_real_accounts=bool(raw.get("allow_real_accounts", False)),
        max_command_age_seconds=int(raw.get("max_command_age_seconds", 120)),
        quote_max_age_seconds=int(raw.get("quote_max_age_seconds", 60)),
        server_day_utc_offset_hours=float(raw.get("server_day_utc_offset_hours", 0)),
        deviation_points=int(raw.get("deviation_points", 20)),
    )
    return ConnectorConfig(
        engine=engine,
        supabase_url=raw["supabase_url"],
        service_key_env=raw.get("service_key_env", "TC_SUPABASE_SERVICE_KEY"),
        terminal_path=acc["terminal_path"],
        password_env=acc.get("password_env"),
        poll_seconds=float(raw.get("poll_seconds", 2)),
    )


def _reject_inline_secrets(obj, path: str = "") -> None:
    """Refuse configs that contain secrets directly (they belong in env vars / keyring)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if any(h in k.lower() for h in SECRET_HINT) and not k.lower().endswith("_env"):
                raise ValueError(f"Config key '{path}{k}' looks like a secret. Put it in an environment variable and reference it with '{k}_env'.")
            _reject_inline_secrets(v, f"{path}{k}.")


def read_secret(name: str | None) -> str | None:
    """Environment variable first, then Windows Credential Manager (service 'trade-command')."""
    if not name:
        return None
    if os.environ.get(name):
        return os.environ[name]
    try:
        import keyring  # optional dependency

        return keyring.get_password("trade-command", name)
    except Exception:
        return None
