"""特徴量レジストリと信用残特徴量のテスト。"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qaiz_lab.calendar import ExecutionConvention
from qaiz_lab.features import REGISTRY, correlation_clusters
from qaiz_lab.features.margin import (
    build_r001_signals,
    margin_panel,
    margin_ratio,
    weeks_from_sessions,
)
from qaiz_lab.features.registry import FeatureSpec
from qaiz_lab.prices import build_price_panel
from qaiz_lab.providers import normalize
from qaiz_lab.providers.synthetic import SyntheticConfig, make_market


@pytest.fixture(scope="module")
def context():
    m = make_market(SyntheticConfig(n_codes=30, n_days=400))
    quotes, _ = normalize.quotes_frame(m["bars"])
    panel = build_price_panel(quotes)
    table = normalize.margin_frame(m["margin_raw"], calendar=panel.calendar)
    days = panel.dates[260:340]
    decision = panel.calendar.decision_timestamps(days, ExecutionConvention())
    mpanel = margin_panel(table, decision, panel.codes)
    return {"panel": panel, "table": table, "mpanel": mpanel, "days": days}


# ------------------------------------------------------- レジストリ --


def test_all_registered_features_have_availability() -> None:
    """利用可能時点が書いていない特徴量を許さない。

    availability の無い特徴量は PIT の検証ができない = 使ってはいけない。
    """
    for name in REGISTRY.names():
        spec = REGISTRY.get(name)
        assert spec.availability.strip(), f"{name} に availability が無い"
        assert spec.source.strip(), f"{name} に source が無い"
        assert spec.calculation.strip(), f"{name} に calculation が無い"


def test_margin_features_flag_unverified_availability() -> None:
    """公表規則が未検証であることが特徴量定義に残っていること。"""
    spec = REGISTRY.get("margin_long_chg_20d")
    assert "UNVERIFIED" in spec.availability or "未検証" in spec.availability


def test_duplicate_registration_with_different_definition_fails() -> None:
    spec = FeatureSpec(
        name="margin_ratio", category="margin", definition="別の定義",
        source="x", lookback=None, calculation="y", availability="z",
    )
    with pytest.raises(ValueError, match="二重登録"):
        REGISTRY.register(spec)


def test_dictionary_table_is_generated_from_code() -> None:
    md = REGISTRY.build_dictionary()
    assert md.startswith("| 特徴量 |")
    assert "`margin_long_chg_20d`" in md
    assert "`mom_12_1`" in md


def test_correlation_clusters_group_identical_features() -> None:
    """実質同じ特徴量が同じクラスタにまとまること (README 17)。"""
    idx = pd.bdate_range("2024-01-01", periods=60)
    cols = [f"C{i}" for i in range(30)]
    rng = np.random.default_rng(1)
    base = pd.DataFrame(rng.standard_normal((60, 30)), index=idx, columns=cols)

    features = {
        "a": base,
        "a_scaled": base * 3.0 + 1.0,     # 単調変換 = 順位が同じ
        "unrelated": pd.DataFrame(rng.standard_normal((60, 30)), index=idx, columns=cols),
    }
    clusters = correlation_clusters(features, threshold=0.9)
    grouped = next(c for c in clusters if "a" in c)
    assert "a_scaled" in grouped, "単調変換した同一情報が別クラスタになっている"
    assert "unrelated" not in grouped


# ------------------------------------------------------- 信用残特徴 --


def test_weeks_conversion() -> None:
    assert weeks_from_sessions(5) == 1
    assert weeks_from_sessions(20) == 4
    assert weeks_from_sessions(60) == 12
    assert weeks_from_sessions(1) == 1, "1営業日でも週次観測 1 本は必要"


def test_margin_ratio_is_nan_when_short_balance_is_zero() -> None:
    """売残 0 を大きな数で埋めないこと。

    埋めると分位の最上位が「売残ゼロの銘柄」で占められ、
    信用倍率ではなく別の現象を見ることになる。
    """
    idx = pd.MultiIndex.from_tuples(
        [(pd.Timestamp("2024-01-10"), "1000"), (pd.Timestamp("2024-01-10"), "2000")],
        names=["date", "code"],
    )
    panel = pd.DataFrame({"margin_long": [100.0, 100.0], "margin_short": [0.0, 50.0]}, index=idx)
    out = margin_ratio(panel)
    assert pd.isna(out.loc[pd.Timestamp("2024-01-10"), "1000"])
    assert out.loc[pd.Timestamp("2024-01-10"), "2000"] == 2.0


def test_r001_signals_skip_mktcap_when_shares_unknown(context) -> None:
    """発行済株式数が無ければ *_to_mktcap を作らない (ADV で代用しない)。

    代用すると *_to_adv と同じものが 2 本並び、
    「独立な 7 シグナルを試した」という多重検定の勘定が狂う。
    """
    signals = build_r001_signals(
        context["mpanel"], adv=context["panel"].adv(20), market_cap=None, lookbacks=[20],
    )
    assert "margin_long_to_adv" in signals
    assert "margin_long_to_mktcap" not in signals
    assert "margin_short_to_mktcap" not in signals


def test_r001_signals_have_values(context) -> None:
    signals = build_r001_signals(
        context["mpanel"], adv=context["panel"].adv(20), market_cap=None, lookbacks=[5, 20, 60],
    )
    # 変化率 (3 lookback × 買/売) + 信用倍率 + ADV比 (買/売) = 9
    assert len(signals) == 9
    for name, frame in signals.items():
        assert frame.notna().any().any(), f"{name} が全部 NaN"


def test_margin_change_uses_published_values_only(context) -> None:
    """変化率の元になる値が PIT パネル由来であること。

    パネルは available_at で結合済みなので、変化率も自動的に
    公表済みの値どうしの差になる。
    """
    mpanel = context["mpanel"]
    assert "available_at" in mpanel.columns
    used = mpanel["available_at"].dropna()
    assert len(used) > 0
    decision = context["panel"].calendar.decision_timestamps(
        context["days"], ExecutionConvention()
    )
    dates = used.index.get_level_values("date")
    limits = pd.DatetimeIndex(pd.Series(dates, index=used.index).map(decision))
    assert (pd.DatetimeIndex(used.to_numpy()) <= limits).all()
