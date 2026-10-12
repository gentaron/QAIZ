"""営業日カレンダーと執行タイミングの規約。

日本の取引所休日は法律 (祝日法) で毎年変わるうえ、振替休日・年末年始・
臨時休業がある。カレンダーをハードコードすると必ずどこかで実際とずれる。

そこで **カレンダーは価格データから導出する**。「その日にバーがある = 取引所が
開いていた」というのは、外部の休日表より信頼できる一次情報である。
価格データが無い期間についてはカレンダーも存在しないので、その期間の
シグナルは計算されない (これは正しい挙動で、埋めてはいけない)。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

JST = "Asia/Tokyo"

# 東証の大引け。2024年11月の取引時間延長で 15:00 → 15:30 になったが、
# ここでは常に **15:00 (早いほう)** を既定にしている。
#
# 理由: 前提を遅い側 (15:30) に置くと、実際の大引けが 15:00 だった期間について
# 「15:10 に公表された情報を、その日の引けで使えた」ことにしてしまう。これは
# 未来情報の混入そのもの。逆に早い側に置いた場合の誤りは「使えた情報を使わない」
# であり、結果を過小評価する方向にしか働かない。
#
# 延長の施行日を一次情報で確認できた時点で、日付で切り替える実装に変えてよい。
SESSION_CLOSE_JST = "15:00"


@dataclass(frozen=True)
class ExecutionConvention:
    """いつ判断し、いつ約定するか。

    ここを曖昧にしたバックテストは、ほぼ確実に 1 日分の未来を先取りしている。
    「終値でシグナルを作り、その終値から測ったリターンで評価する」のが典型例で、
    見た目のシャープが数倍になる。

    既定値は最も保守的な組み合わせ:
        判断    = D 営業日の大引け時点で入手済みの情報のみ
        約定    = D+1 営業日の**始値**
        リターン= D+1 の始値 → D+1+h の始値
    """

    #: 判断に使える情報の締め切り (営業日 D のこの時刻まで)
    decision_time_jst: str = SESSION_CLOSE_JST
    #: 判断から約定までの営業日数。0 にすると同日引け約定 (非推奨)
    execution_lag_sessions: int = 1
    #: 約定価格
    execution_price: Literal["open", "close"] = "open"

    def describe(self) -> str:
        return (
            f"判断: D営業日 {self.decision_time_jst} JST 時点で available_at 済みの情報のみ / "
            f"約定: D+{self.execution_lag_sessions} 営業日の{'始値' if self.execution_price == 'open' else '終値'}"
        )


class TradingCalendar:
    """価格データから導出した営業日カレンダー。"""

    def __init__(self, sessions: pd.DatetimeIndex | pd.Series):
        idx = pd.DatetimeIndex(pd.Series(sessions).dropna().unique()).sort_values()
        if idx.tz is not None:
            idx = idx.tz_localize(None)
        self.sessions = idx.normalize()
        self._pos = {d: i for i, d in enumerate(self.sessions)}

    def __len__(self) -> int:
        return len(self.sessions)

    def __contains__(self, day: object) -> bool:
        return pd.Timestamp(day).normalize() in self._pos  # type: ignore[arg-type]

    @classmethod
    def from_prices(cls, prices: pd.DataFrame, date_col: str = "date") -> TradingCalendar:
        """日次バーの日付集合からカレンダーを作る。"""
        if date_col not in prices.columns:
            raise KeyError(f"価格データに {date_col} 列が無い: {list(prices.columns)}")
        return cls(pd.to_datetime(prices[date_col]))

    def position(self, day) -> int | None:
        return self._pos.get(pd.Timestamp(day).normalize())

    def shift(self, day, n: int) -> pd.Timestamp | None:
        """day から n 営業日ずらした日。カレンダー外に出たら None。

        None を「変化なし」として扱ってはいけない。系列の末尾で n 日先が
        存在しないのは正常なこと (未来はまだ来ていない) で、そこを最終日で
        埋めるとホライズンの短いリターンが混ざり、直近ほど有利に見える。
        """
        p = self.position(day)
        if p is None:
            return None
        q = p + n
        if q < 0 or q >= len(self.sessions):
            return None
        return self.sessions[q]

    def shift_index(self, days: pd.DatetimeIndex, n: int) -> pd.Series:
        """DatetimeIndex 全体を n 営業日ずらす (端は NaT)。"""
        pos = np.array([self._pos.get(pd.Timestamp(d).normalize(), -1) for d in days])
        out = np.full(len(days), np.datetime64("NaT"), dtype="datetime64[ns]")
        ok = (pos >= 0) & (pos + n >= 0) & (pos + n < len(self.sessions))
        out[ok] = self.sessions.values[pos[ok] + n]
        return pd.Series(out, index=days, name=f"shift{n:+d}")

    def next_session_on_or_after(self, day) -> pd.Timestamp | None:
        d = pd.Timestamp(day).normalize()
        i = self.sessions.searchsorted(d, side="left")
        return self.sessions[i] if i < len(self.sessions) else None

    def decision_timestamps(
        self, days: pd.DatetimeIndex, conv: ExecutionConvention
    ) -> pd.Series:
        """各営業日の「判断締め切り時刻」を JST のタイムスタンプで返す。

        PIT テーブルの `available_at` と直接比較するための値。日付同士で比較すると
        「公表が当日 16:30、大引けは 15:00」という 1 時間半のずれが消えてしまい、
        当日の引けで使えたことになってしまう。
        """
        base = pd.DatetimeIndex(days).normalize()
        ts = pd.to_datetime(base.astype(str) + " " + conv.decision_time_jst)
        return pd.Series(ts.tz_localize(JST), index=base, name="decision_at")


def business_days_between(cal: TradingCalendar, start, end) -> int | None:
    """2 日付間の営業日数。どちらかがカレンダー外なら None。"""
    a, b = cal.position(start), cal.position(end)
    if a is None or b is None:
        return None
    return b - a
