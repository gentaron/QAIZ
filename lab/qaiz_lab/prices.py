"""価格パネルとコーポレートアクション処理。

## 調整済み価格を自前で作る理由

「調整済み終値」をプロバイダから受け取ってそのまま使うと、2 つの問題が起きる。

1. **調整は遡及的に書き換わる**。今日 2:1 の分割があると、過去 10 年ぶんの
   調整済み終値が一斉に半分になる。つまり調整済み終値の系列は
   Point-in-Time ではない。「2020年時点で見えていた株価」とは違う。
2. プロバイダによって配当を含めるか含めないかが違う。混ぜると銘柄間で
   リターンの定義が食い違う。

このモジュールは **未調整の生値 + 調整係数** を受け取り、調整を自分で当てる。
どちらを使ったかは `PricePanel.adjustment_mode` に残る。

リターン計算そのものに関して言えば、分割の当日をまたぐ 1 日リターンさえ
正しければよいので、遡及書き換えは実害が無い。害があるのは
「株価水準そのもの」を特徴量にする場合 (低位株フラグなど) で、そこでは
未調整の生値を使わなければならない。両方を保持しているのはそのため。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .calendar import TradingCalendar

OHLCV_COLUMNS = ("date", "code", "open", "high", "low", "close", "volume")


class PriceError(ValueError):
    pass


@dataclass
class PricePanel:
    """日次 OHLCV のワイド表現。

    すべて index=date (営業日), columns=code の DataFrame。
    """

    close: pd.DataFrame
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    volume: pd.DataFrame
    turnover: pd.DataFrame
    #: 調整済み終値 (リターン計算用)
    adj_close: pd.DataFrame
    adj_open: pd.DataFrame
    adjustment_mode: str
    calendar: TradingCalendar

    @property
    def codes(self) -> list[str]:
        return list(self.close.columns)

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.close.index)

    def price_for(self, kind: str) -> pd.DataFrame:
        """約定価格に使う面を返す。"""
        if kind == "open":
            return self.adj_open
        if kind == "close":
            return self.adj_close
        raise PriceError(f"未知の約定価格種別: {kind}")

    def adv(self, window: int = 20) -> pd.DataFrame:
        """平均売買代金 (円)。流動性制約とマーケットインパクトの分母。

        出来高 (株数) ではなく代金を使う。株数だと 100円の銘柄と 10000円の
        銘柄が同じ「100万株」で同じ流動性に見えてしまう。
        """
        return self.turnover.rolling(window, min_periods=max(2, window // 2)).mean()

    def realized_vol(self, window: int = 60) -> pd.DataFrame:
        """年率換算ボラティリティ。"""
        r = self.returns()
        return r.rolling(window, min_periods=max(5, window // 2)).std(ddof=1) * np.sqrt(252)

    def returns(self) -> pd.DataFrame:
        """調整済み終値の日次単純リターン。"""
        return self.adj_close.pct_change(fill_method=None)


def build_price_panel(
    bars: pd.DataFrame,
    *,
    adjustment_factor_col: str | None = "adjustment_factor",
    turnover_col: str | None = "turnover",
) -> PricePanel:
    """縦持ちの日次バーから PricePanel を組む。

    Parameters
    ----------
    bars:
        `date, code, open, high, low, close, volume` を含む DataFrame。
        任意で `turnover` (売買代金) と `adjustment_factor` を持てる。
    adjustment_factor_col:
        1 日の調整係数 (分割なら 0.5 など)。列が無い場合は無調整として扱い、
        `adjustment_mode="none"` を記録する (黙って「調整済み」を名乗らない)。
    """
    missing = [c for c in OHLCV_COLUMNS if c not in bars.columns]
    if missing:
        raise PriceError(f"バーに必須列が無い: {missing}")

    df = bars.copy()
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df["code"] = df["code"].astype(str)

    dup = df.duplicated(subset=["date", "code"]).sum()
    if dup:
        raise PriceError(
            f"(date, code) の重複が {dup} 件ある。重複したままピボットすると "
            "黙って片方が採用され、どちらが残ったか分からなくなる。"
        )

    if turnover_col and turnover_col in df.columns:
        df["_turnover"] = pd.to_numeric(df[turnover_col], errors="coerce")
        turnover_mode = turnover_col
    else:
        # 売買代金が無いときは close × volume で近似する。VWAP ベースの
        # 正しい売買代金より必ず小さめ／大きめにぶれるので、由来を記録しておく。
        df["_turnover"] = df["close"] * df["volume"]
        turnover_mode = "close*volume(approx)"

    def piv(col: str) -> pd.DataFrame:
        return df.pivot(index="date", columns="code", values=col).sort_index()

    close, open_, high, low = piv("close"), piv("open"), piv("high"), piv("low")
    volume, turnover = piv("volume"), piv("_turnover")
    turnover.attrs["mode"] = turnover_mode

    if adjustment_factor_col and adjustment_factor_col in df.columns:
        factor = piv(adjustment_factor_col).fillna(1.0)
        cum = _cumulative_adjustment(factor)
        adj_close, adj_open = close * cum, open_ * cum
        mode = f"cumulative({adjustment_factor_col})"
    else:
        adj_close, adj_open = close, open_
        mode = "none"

    cal = TradingCalendar(close.index)
    return PricePanel(
        close=close, open=open_, high=high, low=low,
        volume=volume, turnover=turnover,
        adj_close=adj_close, adj_open=adj_open,
        adjustment_mode=mode, calendar=cal,
    )


def _cumulative_adjustment(factor: pd.DataFrame) -> pd.DataFrame:
    """日次の調整係数を、過去に遡って掛ける累積係数に直す。

    調整係数 f_t は「t 日に f_t 倍の分割等があった」ことを表す。t 日**以前**の
    価格を f_t 倍すると、t 日以降と地続きの系列になる。よって累積係数は
    「その日より後に起きた全調整の積」であり、末尾から逆向きに累積する。

    末尾を 1.0 に固定するので、直近の株価は生値と一致する。
    """
    f = factor.replace(0, np.nan).fillna(1.0)
    # t 日の係数は t 日「以前」に効くので、1 日ずらしてから逆順累積する
    shifted = f.shift(-1).fillna(1.0)
    rev_cum = shifted[::-1].cumprod()[::-1]
    return rev_cum
