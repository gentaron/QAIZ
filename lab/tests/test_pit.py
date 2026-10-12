"""PIT ストアのテスト。

ここが通らないと、他が全部正しくても研究結果は 1 つも信用できない。
"""

from __future__ import annotations

import pandas as pd
import pytest

from qaiz_lab.calendar import ExecutionConvention, TradingCalendar
from qaiz_lab.pit import PITError, PITTable, publication_available_at


def _calendar() -> TradingCalendar:
    return TradingCalendar(pd.bdate_range("2024-01-01", periods=120))


def _table(**overrides) -> PITTable:
    frame = pd.DataFrame({
        "code": ["1000", "1000", "2000", "2000"],
        "effective_date": ["2024-01-05", "2024-01-12", "2024-01-05", "2024-01-12"],
        "available_at": [
            "2024-01-09 16:30", "2024-01-16 16:30",
            "2024-01-09 16:30", "2024-01-16 16:30",
        ],
        "margin_long": [100.0, 150.0, 200.0, 180.0],
        "margin_short": [50.0, 40.0, 30.0, 60.0],
    })
    kwargs = dict(frame=frame, value_columns=("margin_long", "margin_short"), source="test")
    kwargs.update(overrides)
    return PITTable(**kwargs)


def test_requires_available_at() -> None:
    frame = pd.DataFrame({"code": ["1000"], "effective_date": ["2024-01-05"], "v": [1.0]})
    with pytest.raises(PITError, match="必須列"):
        PITTable(frame=frame, value_columns=("v",), source="test")


def test_rejects_missing_available_at_values() -> None:
    frame = pd.DataFrame({
        "code": ["1000"], "effective_date": ["2024-01-05"],
        "available_at": [None], "v": [1.0],
    })
    with pytest.raises(PITError, match="available_at が欠損"):
        PITTable(frame=frame, value_columns=("v",), source="test")


def test_rejects_available_before_effective() -> None:
    """事実より前に公表されることはない。変換バグを入口で止める。"""
    frame = pd.DataFrame({
        "code": ["1000"], "effective_date": ["2024-01-12"],
        "available_at": ["2024-01-05 16:30"], "v": [1.0],
    })
    with pytest.raises(PITError, match="effective_date より前"):
        PITTable(frame=frame, value_columns=("v",), source="test")


def test_asof_panel_does_not_leak_before_publication() -> None:
    """**このテストが R001 の生命線**。

    基準日 1/5 の観測は 1/9 16:30 に公表される。1/8 の判断時点では
    まだ使えてはならない。ここが通らないなら、信用残の研究は
    「公表前の数字で売買した」バックテストになる。
    """
    table = _table()
    cal = _calendar()
    conv = ExecutionConvention()
    days = pd.DatetimeIndex(["2024-01-08", "2024-01-09", "2024-01-10", "2024-01-17"])
    decision = cal.decision_timestamps(days, conv)

    panel = table.asof_panel(decision, ["1000"])

    # 1/8: 公表前 → 値なし
    assert pd.isna(panel.loc[(pd.Timestamp("2024-01-08"), "1000"), "margin_long"])
    # 1/9: 判断は 15:00、公表は 16:30 → **まだ使えない**
    assert pd.isna(panel.loc[(pd.Timestamp("2024-01-09"), "1000"), "margin_long"]), (
        "公表 16:30 より前の 15:00 時点で値が入っている。時刻を無視して"
        "日付だけで結合している疑いがある。"
    )
    # 1/10: 前日公表ぶんが使える
    assert panel.loc[(pd.Timestamp("2024-01-10"), "1000"), "margin_long"] == 100.0
    # 1/17: 2 本目 (1/16 公表) が使える
    assert panel.loc[(pd.Timestamp("2024-01-17"), "1000"), "margin_long"] == 150.0


def test_staleness_cutoff_blanks_old_observations() -> None:
    """提供が止まったデータをいつまでも使い続けない。"""
    table = _table(max_staleness_days=10)
    cal = TradingCalendar(pd.bdate_range("2024-01-01", periods=200))
    days = pd.DatetimeIndex(["2024-02-20"])
    decision = cal.decision_timestamps(days, ExecutionConvention())

    panel = table.asof_panel(decision, ["1000"])
    assert pd.isna(panel.loc[(pd.Timestamp("2024-02-20"), "1000"), "margin_long"]), (
        "1 か月以上前の観測が max_staleness_days=10 を超えても使われている"
    )


def test_staleness_allows_recent_observations() -> None:
    table = _table(max_staleness_days=10)
    cal = _calendar()
    days = pd.DatetimeIndex(["2024-01-18"])
    decision = cal.decision_timestamps(days, ExecutionConvention())
    panel = table.asof_panel(decision, ["1000"])
    assert panel.loc[(pd.Timestamp("2024-01-18"), "1000"), "margin_long"] == 150.0


def test_coverage_reports_publication_lag() -> None:
    cov = _table().coverage()
    assert cov["rows"] == 4
    assert cov["codes"] == 2
    # 1/5 基準 → 1/9 公表 = 4 日、1/12 → 1/16 = 4 日
    assert cov["median_publication_lag_days"] == pytest.approx(4.6875, abs=1e-3)


def test_publication_available_at_respects_holidays() -> None:
    """営業日カレンダー経由で公表日を出す。暦日で足すと祝日週でずれる。"""
    sessions = pd.DatetimeIndex([
        "2024-01-04", "2024-01-05", "2024-01-09", "2024-01-10", "2024-01-11",
    ])  # 1/8 は休場
    cal = TradingCalendar(sessions)
    out = publication_available_at(
        pd.Series([pd.Timestamp("2024-01-05")]),
        calendar=cal, lag_business_days=2, publish_time_jst="16:30", extra_lag_days=0,
    )
    # 1/5 の 2 営業日後は 1/8 ではなく 1/10 (1/8 は休場)
    assert out.iloc[0] == pd.Timestamp("2024-01-10 16:30", tz="Asia/Tokyo")


def test_conservative_extra_lag_pushes_availability_later() -> None:
    sessions = pd.bdate_range("2024-01-01", periods=30)
    cal = TradingCalendar(sessions)
    base = publication_available_at(
        pd.Series([pd.Timestamp("2024-01-05")]), calendar=cal,
        lag_business_days=2, publish_time_jst="16:30", extra_lag_days=0,
    ).iloc[0]
    conservative = publication_available_at(
        pd.Series([pd.Timestamp("2024-01-05")]), calendar=cal,
        lag_business_days=2, publish_time_jst="16:30", extra_lag_days=1,
    ).iloc[0]
    assert conservative > base, "保守側の上乗せが available_at を遅らせていない"


def test_empty_codes_returns_empty_panel() -> None:
    table = _table()
    cal = _calendar()
    decision = cal.decision_timestamps(pd.DatetimeIndex(["2024-01-10"]), ExecutionConvention())
    panel = table.asof_panel(decision, [])
    assert panel.empty
    assert "margin_long" in panel.columns
