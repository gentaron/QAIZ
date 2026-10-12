"""バックテスト過適合の定量化。

「シャープ 1.8 が出た」だけでは何も言えない。**何回試したか**を併記しない
シャープは意味を持たない。100 通り試して最良を選べば、完全なノイズからでも
シャープ 1.5 前後は普通に出る。

このモジュールは 3 つを提供する。

    expected_max_sharpe   … N 回試したときに偶然到達するシャープの期待最大値
    deflated_sharpe_ratio … 試行回数・歪度・尖度で割り引いた有意性
    cscv_pbo              … 過適合確率 (Probability of Backtest Overfitting)

参考:
  Bailey & López de Prado (2014), "The Deflated Sharpe Ratio"
  Bailey, Borwein, López de Prado & Zhu (2017), "The Probability of Backtest Overfitting"

依存を増やさないため、正規分布の CDF / 逆関数は `math.erf` と有理近似で
自前実装している (`scipy.stats.norm` と 1e-9 程度で一致することをテストで確認)。
"""

from __future__ import annotations

import math
from itertools import combinations

import numpy as np
import pandas as pd

EULER_MASCHERONI = 0.5772156649015329


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_ppf(p: float) -> float:
    """標準正規分布の逆累積分布 (Acklam の有理近似)。相対誤差 ~1e-9。"""
    if not 0.0 < p < 1.0:
        raise ValueError(f"p は (0,1) でなければならない: {p}")
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425

    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    elif p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    else:
        q = p - 0.5
        r = q * q
        x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)

    # ニュートン法で 1 回磨く
    e = norm_cdf(x) - p
    u = e * math.sqrt(2 * math.pi) * math.exp(x * x / 2)
    return x - u / (1 + x * u / 2)


def expected_max_sharpe(n_trials: int, sharpe_std: float = 1.0) -> float:
    """N 回試したときに偶然到達するシャープの期待最大値 (1 期間あたり)。

    これを超えていない戦略は、「試した回数ぶんの運」で説明がつく。
    """
    n = max(2, int(n_trials))
    return sharpe_std * (
        (1 - EULER_MASCHERONI) * norm_ppf(1 - 1.0 / n)
        + EULER_MASCHERONI * norm_ppf(1 - 1.0 / (n * math.e))
    )


def probabilistic_sharpe_ratio(
    returns: pd.Series, benchmark_sr: float = 0.0
) -> float | None:
    """観測シャープが benchmark_sr を真に上回っている確率。

    歪度と尖度を考慮する。日次リターンは左に裾が厚いことが多く、
    その場合シャープは同じでも信頼度は下がる。
    """
    r = pd.Series(returns).astype(float).replace([np.inf, -np.inf], np.nan).dropna()
    n = len(r)
    if n < 20:
        return None
    sd = r.std(ddof=1)
    if sd < 1e-15:
        return None
    sr = float(r.mean() / sd)
    skew = float(r.skew())
    kurt = float(r.kurtosis()) + 3.0  # pandas は超過尖度を返す
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr**2
    if denom <= 0:
        return None
    return norm_cdf((sr - benchmark_sr) * math.sqrt(n - 1) / math.sqrt(denom))


def deflated_sharpe_ratio(
    returns: pd.Series,
    *,
    n_trials: int,
    trial_sharpe_std: float | None = None,
) -> dict:
    """試行回数で割り引いたシャープの有意性。

    Parameters
    ----------
    n_trials:
        実際に試した戦略・パラメータの総数。**過少申告すると意味が無い**。
        `configs/research/*.json` の `planned_tests` と `EXPERIMENT_LOG.md` の
        実績を突き合わせて、大きいほうを渡すこと。
    trial_sharpe_std:
        **1 期間あたり**シャープの試行間標準偏差。実際に複数試行を回したなら、
        その標準偏差を渡すこと (それが最も正確)。

        省略時は帰無仮説の下でのシャープ推定量の標準誤差 1/√T を使う。
        年率シャープの感覚で 1.0 のような値を既定にしてはいけない —
        1 期間あたりのシャープは通常 0.01〜0.1 のオーダーなので、
        1.0 を入れると閾値が 20 倍以上高くなり、どんな戦略も棄却される。
        「常に棄却する検定」は「常に採択する検定」と同じくらい役に立たない。
    """
    r = pd.Series(returns).astype(float).replace([np.inf, -np.inf], np.nan).dropna()
    if len(r) < 20:
        return {"dsr": None, "note": "観測が 20 未満で評価できない"}

    sd = r.std(ddof=1)
    if sd < 1e-15:
        return {"dsr": None, "note": "ボラティリティがゼロ"}

    sr = float(r.mean() / sd)
    # 試行間のばらつきが与えられなければ、帰無仮説下でのシャープ推定量の
    # 標準誤差 1/√T を使う (1 期間あたりの単位)。
    sigma_sr = 1.0 / math.sqrt(len(r)) if trial_sharpe_std is None else float(trial_sharpe_std)
    sr0 = expected_max_sharpe(n_trials, sigma_sr)
    dsr = probabilistic_sharpe_ratio(r, benchmark_sr=sr0)

    return {
        "observed_sharpe_per_period": sr,
        "observed_sharpe_annual": sr * math.sqrt(252),
        "n_trials": int(n_trials),
        "trial_sharpe_std": sigma_sr,
        "trial_sharpe_std_source": (
            "1/sqrt(T) (帰無仮説下の標準誤差)" if trial_sharpe_std is None else "呼び出し側が指定"
        ),
        "expected_max_sharpe_under_null": sr0,
        "psr_vs_zero": probabilistic_sharpe_ratio(r, 0.0),
        "dsr": dsr,
        "verdict": _dsr_verdict(dsr),
        "_note": (
            "dsr は「試行回数を考慮してもなお 0 を上回っている確率」。"
            "0.95 を超えて初めて統計的な主張ができる。下回る場合、"
            "バックテストが良く見えるのは探索の副産物として説明がつく。"
        ),
    }


def _dsr_verdict(dsr: float | None) -> str:
    if dsr is None:
        return "insufficient evidence"
    if dsr >= 0.95:
        return "robust evidence"
    if dsr >= 0.90:
        return "weak evidence"
    if dsr >= 0.50:
        return "inconclusive"
    return "likely overfit"


def cscv_pbo(performance: pd.DataFrame, n_partitions: int = 8) -> dict:
    """CSCV による過適合確率 (PBO)。

    考え方:
        1. 期間を S 個のブロックに分ける
        2. S/2 個を IS、残りを OOS にする全組み合わせを作る
        3. 各組で「IS で最良だった戦略」の OOS 順位を見る
        4. その順位が中央値より下だった割合が PBO

    PBO が 0.5 に近いなら、「IS で最良を選ぶ」という手続き自体に
    OOS 性能の予測力が無い、ということ。個々の戦略の良し悪しではなく
    **選び方**を評価しているのがこの指標の要点。

    Parameters
    ----------
    performance:
        index=時点, columns=戦略。各セルはその時点のリターン。
        列が 2 本しか無いと意味のある結果にならない (最低 5 本は欲しい)。
    """
    M = performance.dropna(how="all")
    if M.shape[1] < 2 or M.shape[0] < n_partitions * 4:
        return {"pbo": None, "note": "戦略数または観測数が足りない"}

    S = n_partitions if n_partitions % 2 == 0 else n_partitions + 1
    blocks = np.array_split(np.arange(len(M)), S)
    logits = []

    for is_idx in combinations(range(S), S // 2):
        oos_idx = [k for k in range(S) if k not in is_idx]
        is_rows = np.concatenate([blocks[k] for k in is_idx])
        oos_rows = np.concatenate([blocks[k] for k in oos_idx])

        is_sr = _sharpe_matrix(M.iloc[is_rows])
        oos_sr = _sharpe_matrix(M.iloc[oos_rows])
        if is_sr.isna().all() or oos_sr.isna().all():
            continue

        best = is_sr.idxmax()
        ranks = oos_sr.rank(ascending=True, pct=True)
        w = float(ranks.get(best, np.nan))
        if not np.isfinite(w) or w <= 0 or w >= 1:
            w = min(max(w if np.isfinite(w) else 0.5, 1e-6), 1 - 1e-6)
        logits.append(math.log(w / (1 - w)))

    if not logits:
        return {"pbo": None, "note": "有効な組み合わせが作れなかった"}

    arr = np.array(logits)
    pbo = float((arr <= 0).mean())
    return {
        "pbo": pbo,
        "n_combinations": len(logits),
        "n_strategies": int(M.shape[1]),
        "median_logit": float(np.median(arr)),
        "verdict": (
            "likely overfit" if pbo >= 0.5 else "inconclusive" if pbo >= 0.25 else "acceptable"
        ),
        "_note": "PBO は「IS で最良を選ぶ手続き」の劣化確率。個別戦略の優劣ではない。",
    }


def _sharpe_matrix(block: pd.DataFrame) -> pd.Series:
    mu = block.mean()
    sd = block.std(ddof=1)
    return (mu / sd.where(sd > 1e-15)).astype(float)
