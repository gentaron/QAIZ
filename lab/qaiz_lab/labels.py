"""ターゲット (ラベル) の生成。

## シグナル日とリターン測定区間がずれていないか

ラベル生成でいちばん多い事故は、シグナル日 D の終値からリターンを測ることである。
D の終値でシグナルを作ったなら、その終値では**もう売買できない**。
「引けで判断して引けで約定する」は物理的に不可能な仮定で、
リターンの一部を先取りしている。

このモジュールは `ExecutionConvention` を必ず受け取り、

    シグナル日 D
      → 約定日 E = D + execution_lag_sessions 営業日
      → ラベル = P(E+h) / P(E) - 1        (P は約定価格面: 始値 or 終値)

として計算する。E が存在しない (系列の末尾) 行は NaN になり、埋めない。

## 超過リターン

生リターンだけを見て判断しない。日本株の日次リターンは市場成分が支配的で、
生リターンの IC は「その日 TOPIX が上がったか」に強く引きずられる。
market_excess (ユニバース平均を引く) と sector_excess (業種平均を引く) を
必ず並べる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .calendar import ExecutionConvention
from .prices import PricePanel


def forward_returns(
    panel: PricePanel,
    horizon: int,
    conv: ExecutionConvention,
) -> pd.DataFrame:
    """シグナル日を index とする h 営業日先リターン。

    Returns
    -------
    index=シグナル日, columns=code。約定日または満期日が系列外の行は NaN。
    """
    if horizon <= 0:
        raise ValueError("horizon は 1 以上でなければならない")

    px = panel.price_for(conv.execution_price)
    cal = panel.calendar
    dates = panel.dates

    entry = cal.shift_index(dates, conv.execution_lag_sessions)
    exit_ = cal.shift_index(dates, conv.execution_lag_sessions + horizon)

    p_entry = px.reindex(pd.DatetimeIndex(entry.dropna().values))
    p_exit = px.reindex(pd.DatetimeIndex(exit_.dropna().values))

    valid = entry.notna() & exit_.notna()
    out = pd.DataFrame(np.nan, index=dates, columns=px.columns, dtype=float)
    if not valid.any():
        return out

    idx = dates[valid.values]
    e = px.reindex(pd.DatetimeIndex(entry[valid.values].values)).to_numpy(dtype=float)
    x = px.reindex(pd.DatetimeIndex(exit_[valid.values].values)).to_numpy(dtype=float)

    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where((e > 0) & np.isfinite(e) & np.isfinite(x), x / e - 1.0, np.nan)

    out.loc[idx, :] = r
    del p_entry, p_exit
    return out


def to_market_excess(returns: pd.DataFrame, weights: pd.DataFrame | None = None) -> pd.DataFrame:
    """ユニバース平均を引いた超過リターン。

    weights を渡さなければ等ウェイト平均を引く。等ウェイトを既定にするのは、
    時価総額加重だと数銘柄の大型株が「市場」を定義してしまい、小型株側の
    超過リターンが構造的にプラスに偏るため。
    """
    if weights is None:
        mkt = returns.mean(axis=1, skipna=True)
    else:
        w = weights.reindex_like(returns).where(returns.notna())
        w = w.div(w.sum(axis=1), axis=0)
        mkt = (returns * w).sum(axis=1, min_count=1)
    return returns.sub(mkt, axis=0)


def to_sector_excess(returns: pd.DataFrame, sectors: pd.Series, min_names: int = 5) -> pd.DataFrame:
    """業種平均を引いた超過リターン。

    その日その業種の有効銘柄が `min_names` 未満なら NaN にする。
    3 銘柄の業種平均を引いた「業種超過」は、実質その 3 銘柄の相対順位でしかない。
    """
    sec = sectors.reindex(returns.columns)
    out = pd.DataFrame(np.nan, index=returns.index, columns=returns.columns, dtype=float)
    for cols in sec.groupby(sec).groups.values():
        cols = [c for c in cols if c in returns.columns]
        if not cols:
            continue
        block = returns[cols]
        counts = block.notna().sum(axis=1)
        mean = block.mean(axis=1, skipna=True).where(counts >= min_names)
        out[cols] = block.sub(mean, axis=0)
    return out


def build_targets(
    panel: PricePanel,
    conv: ExecutionConvention,
    horizons: list[int],
    sectors: pd.Series | None = None,
    variants: tuple[str, ...] = ("raw", "market_excess", "sector_excess"),
) -> dict[str, pd.DataFrame]:
    """`{"fwd20_market_excess": DataFrame, ...}` を組み立てる。"""
    out: dict[str, pd.DataFrame] = {}
    for h in horizons:
        raw = forward_returns(panel, h, conv)
        if "raw" in variants:
            out[f"fwd{h}_raw"] = raw
        if "market_excess" in variants:
            out[f"fwd{h}_market_excess"] = to_market_excess(raw)
        if "sector_excess" in variants:
            if sectors is None:
                raise ValueError("sector_excess を要求されたが sectors が渡されていない")
            out[f"fwd{h}_sector_excess"] = to_sector_excess(raw, sectors)
    return out
