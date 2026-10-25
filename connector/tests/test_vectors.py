"""Runs the same vectors as src/domain/vectors.test.ts so app and connector agree exactly."""
import json
from pathlib import Path

import pytest

from tradecommand_connector import rules

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "src/domain/__vectors__/strategy-risk.json").read_text())


@pytest.mark.parametrize("v", VECTORS["levels"])
def test_levels(v):
    assert rules.stop_loss(v["direction"], v["entry"], v["slDistance"], v["tickSize"]) == v["sl"]
    assert rules.default_take_profit(v["direction"], v["entry"], v["tpPips"], v["pipSize"], v["tickSize"]) == v["tp"]


@pytest.mark.parametrize("v", VECTORS["sizing"])
def test_sizing(v):
    s = rules.size_position(v["budget"], v["entry"], v["sl"], v["tickSize"], v["tickValue"], v["vmin"], v["vmax"], v["vstep"], v["commission"])
    assert s.volume == v["volume"]
    assert s.risk == v["risk"]


def test_compatibility_requires_evidence():
    items = [{"item_key": k, "status": "permitted", "source": "x", "verified_on": "2026-01-01"} for k in rules.COMPATIBILITY_ITEMS]
    assert rules.compatibility_blockers(items, True) == []
    items[0] = {"item_key": "automatedExecution", "status": "permitted"}
    assert rules.compatibility_blockers(items, True) == ["automatedExecution: permitted without source and verification date"]
    assert "eaOrApi: unknown" in rules.compatibility_blockers([], False)
    assert not any(b.startswith("pendingOrders") for b in rules.compatibility_blockers([], False))


def test_validate_levels():
    assert rules.validate_levels("BUY", "limit", 4077, 4062, 4080, 4080.3, 4080.5, 0.01, 0) == []
    assert rules.validate_levels("BUY", "limit", 4080.5, 4065.5, 4083.5, 4080.3, 4080.5, 0.01, 0) == ["BUY LIMIT 4080.5 must be below ask 4080.5"]
    assert rules.validate_levels("SELL", "limit", 4083, 4098, 4080, 4080.3, 4080.5, 0.01, 0) == []
    assert "stop-loss closer than broker minimum 20" in rules.validate_levels("BUY", "limit", 4077, 4062, 4080, 4080.3, 4080.5, 0.01, 20)
    assert rules.validate_levels("BUY", "limit", 4077.005, 4062, 4080, 4080.3, 4080.5, 0.01, 0)
