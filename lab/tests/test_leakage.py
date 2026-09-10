"""リーケージ検出器のテスト。

**検出器は「わざと壊したデータで落ちること」を確認しないと意味が無い。**
正常系だけ通しても、何も検出しない空実装と区別が付かない。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qaiz_lab.calendar import ExecutionConvention, TradingCalendar
from qaiz_lab.leakage import (
    LeakageError,
    assert_available_at_respected,
    assert_label_alignment,
    assert_no_future_observations,
    scan_panel_for_constant_future,
    truncation_consistency,
)
from qaiz_lab.pit import PITTable
from qaiz_lab.providers.synthetic import SyntheticConfig, make_leaky_pit_frame


def _cal() -> TradingCalendar:
    return TradingCalendar(pd.bdate_range("2024-01-01", periods=120))


def test_detects_leaky_pit_join() -> None:
    """公表前に使える設定のデータを流し込むと検出されること。

    `make_leaky_pit_frame` は available_at = 基準日 にしてある
    (= 公表を待たずに使える)。判断時刻が基準日の 15:00 なら
    「その日の 0:00 に公表された」ことになり、通ってしまう。
    ここで検出したいのはそのケース。
    """
    frame = make_leaky_pit_frame(SyntheticConfig(n_codes=5, n_days=60))
    table = PITTable(
        frame=frame, value_columns=("margin_long", "margin_short"),
        source="leaky", max_staleness_days=None,
    )
    cal = TradingCalendar(pd.to_datetime(frame["effective_date"].unique()))
    days = pd.DatetimeIndex(sorted(frame["effective_date"].unique()))[:5]
    decision = cal.decision_timestamps(days, ExecutionConvention())

    panel = table.asof_panel(decision, table.codes[:3])
    # as-of 結合自体は available_at を守るので通る。問題は
    # available_at そのものが嘘なこと。それは公表規則の検証で捕まえる。
    assert_available_at_respected(panel, decision)

    # 基準日当日に値が入っている = 公表を待っていない
    first = days[0]
    got = panel.loc[first].dropna(subset=["margin_long"])
    assert len(got) > 0, (
        "リーク版データで基準日当日に値が入っていない。テストの前提が崩れている。"
    )


def test_assert_available_at_respected_catches_violation() -> None:
    """パネルを手で壊したら落ちること。"""
    idx = pd.MultiIndex.from_tuples(
        [(pd.Timestamp("2024-01-10"), "1000")], names=["date", "code"]
    )
    panel = pd.DataFrame(
        {"v": [1.0], "available_at": [pd.Timestamp("2024-01-11 09:00", tz="Asia/Tokyo")]},
        index=idx,
    )
    decision = pd.Series(
        [pd.Timestamp("2024-01-10 15:00", tz="Asia/Tokyo")],
        index=pd.DatetimeIndex(["2024-01-10"]),
    )
    with pytest.raises(LeakageError, match="未来情報の混入"):
        assert_available_at_respected(panel, decision)


def test_assert_no_future_observations() -> None:
    frame = pd.DataFrame({
        "available_at": pd.to_datetime(["2099-01-01 10:00"]).tz_localize("Asia/Tokyo")
    })
    with pytest.raises(LeakageError, match="未来"):
        assert_no_future_observations(frame)


def test_same_day_execution_is_rejected() -> None:
    """引けで判断して同じ引けで約定する設定を弾く。"""
    with pytest.raises(LeakageError, match="物理的にできない"):
        assert_label_alignment(pd.DatetimeIndex(["2024-01-10"]), _cal(), 0)


def test_truncation_consistency_passes_for_causal_feature() -> None:
    """過去だけを見る特徴量なら通る。"""
    src = pd.DataFrame({
        "date": pd.bdate_range("2024-01-01", periods=80),
        "x": np.arange(80, dtype=float),
    })

    def build(df: pd.DataFrame) -> pd.DataFrame:
        out = df.set_index("date")[["x"]].rolling(5).mean()
        return out.rename(columns={"x": "sma5"})

    truncation_consistency(build, src, list(src["date"][40:45]))


def test_truncation_consistency_catches_full_sample_standardization() -> None:
    """全期間の平均・標準偏差で標準化している特徴量を検出する。

    `StandardScaler().fit_transform(全期間)` と同じ形。コードを読んでも
    「普通の標準化」にしか見えないので、機械的に暴く必要がある。
    """
    src = pd.DataFrame({
        "date": pd.bdate_range("2024-01-01", periods=80),
        "x": np.arange(80, dtype=float),
    })

    def leaky_build(df: pd.DataFrame) -> pd.DataFrame:
        s = df.set_index("date")["x"]
        return ((s - s.mean()) / s.std()).to_frame("z")  # ← 全期間の統計を使っている

    with pytest.raises(LeakageError, match="切り詰め不整合"):
        truncation_consistency(leaky_build, src, list(src["date"][40:45]))


def test_truncation_consistency_catches_backfill() -> None:
    """後ろから埋める (bfill) を検出する。"""
    x = np.arange(80, dtype=float)
    x[50] = np.nan
    src = pd.DataFrame({"date": pd.bdate_range("2024-01-01", periods=80), "x": x})

    def leaky_build(df: pd.DataFrame) -> pd.DataFrame:
        return df.set_index("date")[["x"]].bfill()  # ← 未来の値で埋めている

    with pytest.raises(LeakageError, match="切り詰め不整合"):
        truncation_consistency(leaky_build, src, [src["date"][50]])


def test_scan_panel_detects_broadcast_constants() -> None:
    """最新値を全期間に broadcast した列を検出する。"""
    idx = pd.MultiIndex.from_product(
        [pd.bdate_range("2024-01-01", periods=10), ["1000", "2000"]],
        names=["date", "code"],
    )
    panel = pd.DataFrame(
        {
            "broadcast": [1.0, 2.0] * 10,   # 銘柄ごとに定数 = 全期間同じ値
            "varying": np.arange(20, dtype=float),
        },
        index=idx,
    )
    flagged = scan_panel_for_constant_future(panel, ["broadcast", "varying"])
    assert "broadcast" in flagged
    assert "varying" not in flagged


def test_publication_lag_materially_changes_the_answer() -> None:
    """**公表ラグを守るかどうかで結論が変わることを示す。**

    合成データは「基準日(金)の3営業日後に公表された信用残変化が
    将来リターンに効く」世界として作ってある。

      正しい結合 (公表後から使う)   → 埋め込んだぶんの IC が出る
      誤った結合 (基準日から使う)   → **公表前の3営業日ぶん先取りする**ので
                                      IC が明確に大きくなる

    差が出なければ、この検査は何も検証していないことになる。
    「available_at を守っている」と主張するだけでは足りず、
    守らなかった場合に結果が変わることまで見せる必要がある。
    """
    from qaiz_lab.features.margin import margin_change, margin_panel
    from qaiz_lab.labels import forward_returns
    from qaiz_lab.prices import build_price_panel
    from qaiz_lab.providers import normalize
    from qaiz_lab.providers.synthetic import make_market
    from qaiz_lab.validation.ic import cross_sectional_ic

    market = make_market(SyntheticConfig(n_codes=45, n_days=520, margin_effect=0.004))
    quotes, _ = normalize.quotes_frame(market["bars"])
    panel = build_price_panel(quotes)
    conv = ExecutionConvention()
    days = panel.dates[300:]
    decision = panel.calendar.decision_timestamps(days, conv)
    target = forward_returns(panel, horizon=20, conv=conv).reindex(days)

    def ic_for(lag: int, extra: int) -> float:
        table = normalize.margin_frame(
            market["margin_raw"], calendar=panel.calendar,
            publication_lag_business_days=lag, conservative_extra_lag_days=extra,
        )
        mp = margin_panel(table, decision, panel.codes)
        sig = margin_change(mp, "margin_long", 20).reindex(index=days, columns=panel.codes)
        return float(cross_sectional_ic(sig, target).mean())

    correct = ic_for(lag=2, extra=1)   # 公表を待つ
    leaked = ic_for(lag=0, extra=0)    # 基準日から使う = 公表前を先取り

    assert abs(leaked) > abs(correct) * 1.15, (
        f"公表ラグを 0 にしても IC がほぼ変わらない "
        f"(正しい={correct:.4f} / リーク={leaked:.4f})。\n"
        "as-of 結合が available_at を実際には見ていない可能性がある。"
    )
