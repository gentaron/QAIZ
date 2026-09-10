"""ラベル生成と取引コストのテスト。

リターン計算とコストは、間違っていても「それらしい数字」が出る領域なので、
手計算で検証できる小さな入力で押さえておく。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qaiz_lab.calendar import ExecutionConvention
from qaiz_lab.costs import CostModel, apply_lot_rounding
from qaiz_lab.labels import forward_returns, to_market_excess, to_sector_excess
from qaiz_lab.prices import build_price_panel


def _bars(closes: dict[str, list[float]], opens: dict[str, list[float]] | None = None):
    days = pd.bdate_range("2024-01-01", periods=len(next(iter(closes.values()))))
    rows = []
    for code, cs in closes.items():
        os_ = opens[code] if opens else cs
        for i, (o, c) in enumerate(zip(os_, cs, strict=False)):
            rows.append({
                "date": days[i], "code": code, "open": o, "high": max(o, c) * 1.01,
                "low": min(o, c) * 0.99, "close": c, "volume": 1000.0,
                "turnover": 1000.0 * c,
            })
    return pd.DataFrame(rows)


def test_forward_return_measured_from_execution_not_signal() -> None:
    """シグナル日の価格からリターンを測っていないこと。

    始値 [100, 110, 121] に対し、シグナル日 0 のラベルは
    「翌営業日の始値 110 → その 1 日後の始値 121」= +10% でなければならない。
    シグナル日の 100 から測ると +21% になり、1 日ぶん先取りしている。
    """
    bars = _bars(
        closes={"A": [100.0, 110.0, 121.0, 133.1]},
        opens={"A": [100.0, 110.0, 121.0, 133.1]},
    )
    panel = build_price_panel(bars)
    conv = ExecutionConvention(execution_lag_sessions=1, execution_price="open")

    fwd = forward_returns(panel, horizon=1, conv=conv)
    got = fwd.iloc[0]["A"]
    assert got == pytest.approx(0.10, abs=1e-9), (
        f"1営業日先リターンが {got:.4f}。0.21 なら約定日ではなくシグナル日の"
        "価格から測っている (1日ぶんの未来を先取りしている)。"
    )


def test_forward_return_is_nan_at_series_end() -> None:
    """満期が系列外の行は NaN。末尾価格で埋めない。"""
    bars = _bars({"A": [100.0, 101.0, 102.0, 103.0]})
    panel = build_price_panel(bars)
    fwd = forward_returns(panel, horizon=2, conv=ExecutionConvention())
    assert fwd["A"].tail(3).isna().all(), "系列末尾のラベルが埋められている"


def test_market_excess_sums_to_zero() -> None:
    r = pd.DataFrame({"A": [0.02, -0.01], "B": [-0.02, 0.03]},
                     index=pd.bdate_range("2024-01-01", periods=2))
    ex = to_market_excess(r)
    assert np.allclose(ex.sum(axis=1).to_numpy(), 0.0, atol=1e-12)


def test_sector_excess_requires_minimum_names() -> None:
    """銘柄数が足りない業種は NaN になること。"""
    idx = pd.bdate_range("2024-01-01", periods=2)
    r = pd.DataFrame({"A": [0.01, 0.02], "B": [0.03, -0.01]}, index=idx)
    sectors = pd.Series({"A": "S1", "B": "S1"})
    out = to_sector_excess(r, sectors, min_names=5)
    assert out.isna().all().all(), "2銘柄の業種で業種超過が計算されている"


def test_impact_grows_with_participation() -> None:
    """平方根則: ADV の 1% で 1bp、100% で 10bp。"""
    cm = CostModel(impact_coefficient_bps=10.0)
    small = cm.impact_bps(1_000_000, 100_000_000)   # 1%
    large = cm.impact_bps(100_000_000, 100_000_000)  # 100%
    assert float(small) == pytest.approx(1.0, abs=1e-9)
    assert float(large) == pytest.approx(10.0, abs=1e-9)
    assert float(small) < float(large)


def test_unknown_adv_yields_nan_not_zero_cost() -> None:
    """ADV 不明を「インパクト 0」にしない。

    0 にすると、流動性が分からない銘柄が最も建てやすい銘柄になる。
    """
    cm = CostModel()
    assert np.isnan(cm.impact_bps(1_000_000, np.nan))
    assert np.isnan(cm.impact_bps(1_000_000, 0.0))


def test_commission_floor_applies_to_small_trades() -> None:
    cm = CostModel(commission_bps=5.0, commission_floor_jpy=100.0, half_spread_bps=0.0,
                   impact_coefficient_bps=0.0)
    tiny = float(cm.one_way_bps(10_000, 1e9))    # 手数料 5bp = 5円 < 100円の下限
    big = float(cm.one_way_bps(100_000_000, 1e12))
    assert tiny > big, "最低手数料が小口に効いていない"
    assert tiny == pytest.approx(100.0 / 10_000 * 1e4, abs=1e-6)


def test_stress_scaling_multiplies_all_components() -> None:
    base = CostModel(commission_bps=5, half_spread_bps=5, impact_coefficient_bps=10)
    doubled = base.scaled(commission=2, spread=2, impact=2)
    assert doubled.commission_bps == 10
    assert doubled.half_spread_bps == 10
    assert doubled.impact_coefficient_bps == 20
    assert doubled.describe()["stress_multipliers"]["commission"] == 2


def test_tick_table_is_not_silently_approximated(tmp_path) -> None:
    """未実装の呼値階段モデルを、黙って bps 近似に落とさない。"""
    import json

    cfg = {
        "id": "t",
        "commission": {"bps": 5},
        "spread": {"bps": 5, "use_tick_table": True},
        "impact": {"coefficient_bps": 10},
        "borrow": {"annual_fee_bps": 150},
        "settlement": {"lot_size": 100, "round_lots": True},
    }
    p = tmp_path / "cost.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(NotImplementedError, match="呼値階段"):
        CostModel.from_json(p)


def test_lot_rounding_zeroes_positions_below_one_unit() -> None:
    """1 単元に満たない建玉は 0 になる (小口キャパシティの過大評価を防ぐ)。"""
    target = pd.DataFrame({"A": [10_000.0], "B": [1_000_000.0]})
    price = pd.DataFrame({"A": [3_000.0], "B": [3_000.0]})
    out = apply_lot_rounding(target, price, lot=100)
    assert out["A"].iloc[0] == 0.0, "1単元30万円の銘柄に1万円の建玉が残っている"
    assert out["B"].iloc[0] == pytest.approx(900_000.0)
