"""単変量分位ポートフォリオ分析。

各特徴量を Q1..Q5 に切って将来リターンを比べる。IC が「相関があるか」を
1 つの数字で答えるのに対して、分位分析は **形** を見せる。

見るべきなのは Q5-Q1 の差だけではない。

  - 単調か       Q1<Q2<Q3<Q4<Q5 でないなら、線形の予測力ではない
  - 片側だけか   Q5 が強いのか Q1 が弱いのか。後者だけなら空売り前提の戦略になる
  - 端だけか     Q1 と Q5 だけ極端で中間が平坦なら、外れ値の効果を見ている

単調でない特徴量を線形モデルに入れても効かない。分位分析はモデル選択の
前提を決める工程でもある。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..metrics import max_drawdown, sharpe


def quantile_buckets(row: pd.Series, quantiles: int = 5) -> pd.Series:
    """1 日ぶんのクロスセクションを Q1..Qn に切る。"""
    s = pd.to_numeric(row, errors="coerce").dropna()
    if len(s) < quantiles * 2:
        return pd.Series(np.nan, index=row.index, dtype=float)
    ranks = s.rank(method="first")
    bins = pd.qcut(ranks, quantiles, labels=False, duplicates="drop") + 1
    return bins.reindex(row.index).astype(float)


def quantile_returns(
    scores: pd.DataFrame,
    targets: pd.DataFrame,
    *,
    quantiles: int = 5,
    min_names: int = 20,
) -> pd.DataFrame:
    """日付 × 分位の平均リターン表。

    各分位は等ウェイト。時価総額加重にすると、分位の中の最大銘柄が
    その分位を代表してしまい、「Q5 が強い」のか「Q5 に入った大型株が
    強かった」のか区別できなくなる。
    """
    dates = scores.index.intersection(targets.index)
    codes = scores.columns.intersection(targets.columns)
    rows = {}
    for d in dates:
        row = scores.loc[d, codes]
        tgt = pd.to_numeric(targets.loc[d, codes], errors="coerce")
        valid = row.notna() & tgt.notna()
        if int(valid.sum()) < min_names:
            continue
        bins = quantile_buckets(row.where(valid), quantiles)
        rec = {}
        for q in range(1, quantiles + 1):
            sel = bins == q
            rec[f"Q{q}"] = float(tgt[sel].mean()) if sel.any() else np.nan
        rec["spread"] = rec.get(f"Q{quantiles}", np.nan) - rec.get("Q1", np.nan)
        rec["n"] = int(valid.sum())
        rows[d] = rec
    return pd.DataFrame(rows).T.sort_index()


def quantile_summary(qr: pd.DataFrame, *, quantiles: int = 5, periods_per_year: int = 252) -> pd.DataFrame:
    """分位ごとの統計。README 25 で要求された項目を出す。"""
    columns = ["bucket", "n", "mean_return", "median_return", "volatility",
               "sharpe", "max_drawdown", "hit_rate"]
    if qr.empty:
        # 空を握りつぶして 0 を並べない。分位が組めなかったこと自体が結果である。
        return pd.DataFrame(columns=columns).set_index("bucket")

    rows = []
    for q in [f"Q{i}" for i in range(1, quantiles + 1)] + ["spread"]:
        if q not in qr.columns:
            continue
        r = pd.to_numeric(qr[q], errors="coerce").dropna()
        if len(r) < 3:
            rows.append({"bucket": q, "n": int(len(r))})
            continue
        mdd, _ = max_drawdown(r)
        rows.append({
            "bucket": q,
            "n": int(len(r)),
            "mean_return": float(r.mean()),
            "median_return": float(r.median()),
            "volatility": float(r.std(ddof=1)),
            "sharpe": sharpe(r, periods_per_year=periods_per_year),
            "max_drawdown": mdd,
            "hit_rate": float((r > 0).mean()),
        })
    return pd.DataFrame(rows).set_index("bucket")


def monotonicity(summary_df: pd.DataFrame, quantiles: int = 5) -> dict:
    """分位平均リターンの単調性を測る。

    Spearman 相関 (分位番号 vs 平均リターン) が 1 に近ければ単調増加。
    0 付近なら、Q5-Q1 が正でも「予測力がある」とは言えない — 中間が
    でたらめということは、順位そのものには情報が無いということなので。
    """
    means = []
    for i in range(1, quantiles + 1):
        key = f"Q{i}"
        if key in summary_df.index and "mean_return" in summary_df.columns:
            means.append(summary_df.loc[key, "mean_return"])
    means = [m for m in means if pd.notna(m)]
    if len(means) < 3:
        return {"monotonicity": None, "note": "分位が揃っていない"}
    rho = float(pd.Series(means).rank().corr(pd.Series(range(len(means))).rank()))
    return {
        "monotonicity_spearman": rho,
        "strictly_monotonic": bool(all(b > a for a, b in zip(means, means[1:], strict=False))),
        "top_minus_bottom": float(means[-1] - means[0]),
        "_note": "単調性が低いのに spread が大きい場合、端の外れ値を見ている疑いが強い。",
    }
