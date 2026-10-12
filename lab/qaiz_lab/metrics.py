"""パフォーマンス指標。

シャープだけを見ない。シャープはボラティリティが小さいときに簡単に大きくなり、
最大ドローダウンの深さも回転率も約定可能性も見えない。README の 39 に挙げた
指標を一括で出す `summary()` を用意して、常に全部並べる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def _clean(r: pd.Series) -> pd.Series:
    return pd.Series(r).astype(float).replace([np.inf, -np.inf], np.nan).dropna()


def cumulative(returns: pd.Series) -> pd.Series:
    return (1.0 + _clean(returns)).cumprod()


def cagr(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float | None:
    r = _clean(returns)
    if len(r) < 2:
        return None
    total = float((1.0 + r).prod())
    if total <= 0:
        return None  # 破産した系列に年率換算を当てても意味が無い
    years = len(r) / periods_per_year
    return total ** (1.0 / years) - 1.0 if years > 0 else None


def annual_return(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float | None:
    r = _clean(returns)
    return float(r.mean() * periods_per_year) if len(r) else None


def volatility(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float | None:
    r = _clean(returns)
    return float(r.std(ddof=1) * np.sqrt(periods_per_year)) if len(r) > 1 else None


def sharpe(returns: pd.Series, rf: float = 0.0, periods_per_year: int = TRADING_DAYS) -> float | None:
    """年率シャープ。無リスク金利は既定 0 (日本円の短期金利を 0 と置く仮定)。"""
    r = _clean(returns) - rf / periods_per_year
    if len(r) < 2:
        return None
    sd = r.std(ddof=1)
    return float(r.mean() / sd * np.sqrt(periods_per_year)) if sd > 1e-15 else None


def sortino(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float | None:
    r = _clean(returns)
    if len(r) < 2:
        return None
    downside = r[r < 0]
    if len(downside) < 2:
        return None
    dd = np.sqrt((downside**2).mean())
    return float(r.mean() / dd * np.sqrt(periods_per_year)) if dd > 1e-15 else None


def max_drawdown(returns: pd.Series) -> tuple[float | None, int | None]:
    """最大ドローダウン (負値) と、その谷までに要した営業日数。"""
    c = cumulative(returns)
    if len(c) < 2:
        return None, None
    peak = c.cummax()
    dd = c / peak - 1.0
    trough = int(dd.values.argmin())
    peak_idx = int(c.values[: trough + 1].argmax())
    return float(dd.min()), trough - peak_idx


def calmar(returns: pd.Series, periods_per_year: int = TRADING_DAYS) -> float | None:
    g = cagr(returns, periods_per_year)
    mdd, _ = max_drawdown(returns)
    if g is None or mdd is None or mdd >= -1e-12:
        return None
    return float(g / abs(mdd))


def hit_rate(returns: pd.Series) -> float | None:
    r = _clean(returns)
    if len(r) == 0:
        return None
    return float((r > 0).mean())


def profit_factor(returns: pd.Series) -> float | None:
    r = _clean(returns)
    gain = r[r > 0].sum()
    loss = -r[r < 0].sum()
    return float(gain / loss) if loss > 1e-15 else None


def skewness(returns: pd.Series) -> float | None:
    r = _clean(returns)
    return float(r.skew()) if len(r) > 2 else None


def excess_kurtosis(returns: pd.Series) -> float | None:
    r = _clean(returns)
    return float(r.kurtosis()) if len(r) > 3 else None


def historical_var(returns: pd.Series, level: float = 0.95) -> float | None:
    """歴史的 VaR。正の値で「この割合を失う」。"""
    r = _clean(returns)
    if len(r) < 20:
        return None
    return float(-np.quantile(r, 1.0 - level))


def historical_cvar(returns: pd.Series, level: float = 0.95) -> float | None:
    r = _clean(returns)
    if len(r) < 20:
        return None
    cut = np.quantile(r, 1.0 - level)
    tail = r[r <= cut]
    return float(-tail.mean()) if len(tail) else None


def summary(
    returns: pd.Series,
    *,
    turnover: pd.Series | None = None,
    periods_per_year: int = TRADING_DAYS,
    benchmark: pd.Series | None = None,
) -> dict:
    """README 39 で要求している指標を一括で返す。"""
    r = _clean(returns)
    mdd, mdd_days = max_drawdown(r)
    out: dict = {
        "n_periods": int(len(r)),
        "cagr": cagr(r, periods_per_year),
        "annual_return": annual_return(r, periods_per_year),
        "volatility": volatility(r, periods_per_year),
        "sharpe": sharpe(r, periods_per_year=periods_per_year),
        "sortino": sortino(r, periods_per_year),
        "max_drawdown": mdd,
        "max_drawdown_days": mdd_days,
        "calmar": calmar(r, periods_per_year),
        "hit_rate": hit_rate(r),
        "profit_factor": profit_factor(r),
        "skewness": skewness(r),
        "excess_kurtosis": excess_kurtosis(r),
        "var95": historical_var(r, 0.95),
        "cvar95": historical_cvar(r, 0.95),
        "risk_free_assumption": "0% (円短期金利を 0 と仮定)",
    }
    if turnover is not None:
        t = _clean(turnover)
        out["turnover_mean"] = float(t.mean()) if len(t) else None
        out["turnover_annual"] = float(t.mean() * periods_per_year) if len(t) else None
    if benchmark is not None:
        b = _clean(benchmark).reindex(r.index).dropna()
        common = r.index.intersection(b.index)
        if len(common) > 2:
            active = r.loc[common] - b.loc[common]
            te = active.std(ddof=1) * np.sqrt(periods_per_year)
            out["tracking_error"] = float(te)
            out["information_ratio"] = (
                float(active.mean() * periods_per_year / te) if te > 1e-15 else None
            )
    return out
