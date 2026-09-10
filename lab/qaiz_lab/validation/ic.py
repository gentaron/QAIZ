"""情報係数 (IC) — クロスセクショナル予測力の一次評価。

## なぜバックテストより先に IC を見るか

バックテストは「シグナル」「ポートフォリオ構築」「コスト」「制約」が全部
混ざった結果なので、悪かったときにどこが悪いのか分からない。
IC は **シグナルと将来リターンの順位相関** だけを見るので、シグナル自体に
情報があるかどうかが切り分けられる。

## Pearson ではなく Spearman を主に使う理由

株式リターンの分布は裾が厚く、1 銘柄が +80% すると Pearson IC はその 1 本で
決まってしまう。順位相関ならその影響が有界になる。両方計算して並べ、
大きく食い違うときは「少数銘柄が結果を作っている」というサインとして読む。

## ICIR

平均 IC / IC の標準偏差。IC の平均が 0.03 でも、毎回 0.03 なら実用的で、
±0.30 で振れているなら実質ゼロ。平均だけを見て採否を決めない。

## 自己相関の補正

ホライズン 20 日のリターンを日次で評価すると、隣り合う観測が 19 日ぶん
重なる。有効サンプル数は日数ではないので、素朴な t 統計量は過大になる。
`newey_west_t` で重なりを考慮した t を出す。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _rank(v: np.ndarray) -> np.ndarray:
    return pd.Series(v).rank().to_numpy()


def cross_sectional_ic(
    scores: pd.DataFrame,
    targets: pd.DataFrame,
    *,
    method: str = "spearman",
    min_names: int = 20,
) -> pd.Series:
    """日次の IC 系列。

    その日の有効ペアが `min_names` 未満なら NaN。10 銘柄の相関を IC として
    平均に混ぜると、期間の端 (データが薄い時期) が結果を支配する。
    """
    common_dates = scores.index.intersection(targets.index)
    common_codes = scores.columns.intersection(targets.columns)
    s = scores.loc[common_dates, common_codes]
    t = targets.loc[common_dates, common_codes]

    out = {}
    for d in common_dates:
        a = pd.to_numeric(s.loc[d], errors="coerce")
        b = pd.to_numeric(t.loc[d], errors="coerce")
        mask = a.notna() & b.notna()
        n = int(mask.sum())
        if n < min_names:
            out[d] = np.nan
            continue
        x, y = a[mask].to_numpy(float), b[mask].to_numpy(float)
        if method == "spearman":
            x, y = _rank(x), _rank(y)
        if np.std(x) < 1e-12 or np.std(y) < 1e-12:
            out[d] = np.nan
            continue
        out[d] = float(np.corrcoef(x, y)[0, 1])
    return pd.Series(out, name=f"ic_{method}").sort_index()


def newey_west_t(ic: pd.Series, overlap: int) -> float | None:
    """重なりを補正した平均 IC の t 統計量 (Newey-West, ラグ = overlap-1)。

    ホライズン h のリターンを日次で評価すると、観測は h-1 日ぶん重なる。
    素朴な t = mean/se は重なりを無視するので過大になり、有意でないものが
    有意に見える。
    """
    x = pd.Series(ic).astype(float).dropna().to_numpy()
    n = len(x)
    if n < 10:
        return None
    mu = x.mean()
    e = x - mu
    lags = max(0, int(overlap) - 1)
    var = float(e @ e) / n
    for L in range(1, min(lags, n - 1) + 1):
        w = 1.0 - L / (lags + 1)
        cov = float(e[L:] @ e[:-L]) / n
        var += 2.0 * w * cov
    if var <= 0:
        return None
    return float(mu / np.sqrt(var / n))


def ic_summary(ic: pd.Series, *, overlap: int = 1) -> dict:
    x = pd.Series(ic).astype(float).dropna()
    if len(x) < 3:
        return {"n": int(len(x)), "mean_ic": None, "note": "観測が少なすぎて評価できない"}
    sd = float(x.std(ddof=1))
    return {
        "n": int(len(x)),
        "mean_ic": float(x.mean()),
        "median_ic": float(x.median()),
        "ic_std": sd,
        "icir": float(x.mean() / sd) if sd > 1e-12 else None,
        "hit_rate_positive": float((x > 0).mean()),
        "t_stat_naive": float(x.mean() / (sd / np.sqrt(len(x)))) if sd > 1e-12 else None,
        "t_stat_newey_west": newey_west_t(x, overlap),
        "overlap_days": overlap,
        "_note": (
            "t_stat_naive は観測の重なりを無視しているので過大。"
            "overlap>1 のときは t_stat_newey_west のほうを読むこと。"
        ),
    }


def ic_decay(
    scores: pd.DataFrame,
    targets_by_horizon: dict[int, pd.DataFrame],
    *,
    method: str = "spearman",
) -> pd.DataFrame:
    """ホライズン別の IC。シグナルの「賞味期限」を見る。

    1 日で消えるシグナルは、コストを払って取りに行く価値がまず無い。
    逆に 60 日まで残るなら、回転率を落として運用できる。
    """
    rows = []
    for h, tgt in sorted(targets_by_horizon.items()):
        ic = cross_sectional_ic(scores, tgt, method=method)
        s = ic_summary(ic, overlap=h)
        s["horizon"] = h
        rows.append(s)
    return pd.DataFrame(rows).set_index("horizon")
