"""クロスセクション統計プリミティブ。

**このファイルは `src/analytics/stats.ts` の移植であり、独立実装ではない。**

ダッシュボード (TypeScript) が「バリュースコア 72 点」と表示している銘柄について、
研究ラボ (Python) が別の定義で 65 点を出したら、どちらの数字も信用できなくなる。
両者が同じ意味を持つことを保証するために、

  1. この 2 ファイルは同じアルゴリズム・同じ丸めで実装する
  2. `configs/parity_vectors.json` のゴールデンベクタを両言語のテストが検査する
     (`lab/tests/test_parity.py` と `test/parity.test.ts`)

という契約にしてある。片方だけ直すと CI が落ちる。

移植で特に注意した点:
  - 分位点は R type-7 (線形補間)。numpy の既定と同じだが、明示的に実装して
    TS 側と 1 行ずつ対応が取れるようにしてある。
  - Z スコアは**ウィンザライズ後の値**から計算する (TS 側がそうしているため)。
    生値から計算すると外れ値銘柄の z だけが極端に残り、順位が変わる。
  - `z_to_score` の丸めは JavaScript の `Math.round` (0.5 は正方向) に合わせる。
    Python 組み込みの `round` は偶数丸めなので、そのまま使うと 0.05 点ずれる。
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

import numpy as np

__all__ = [
    "is_num",
    "clean",
    "quantile",
    "median",
    "mad",
    "winsorize",
    "zscores",
    "percentile_ranks",
    "z_to_score",
    "weighted_mean",
    "js_round",
]

Num = float | int | None


def js_round(x: float) -> float:
    """JavaScript の `Math.round` と同じ丸め (0.5 は常に正方向)。

    Python の `round` は銀行家丸めなので `round(0.5) == 0`、`round(2.5) == 2` になる。
    TS 側と数値を突き合わせる箇所でこれを使うと、ゴールデンベクタが 1 桁目でずれる。
    """
    return math.floor(x + 0.5)


def is_num(x: object) -> bool:
    """有限な数値か。bool は数値として扱わない (True が 1.0 になる事故を防ぐ)。"""
    if isinstance(x, bool):
        return False
    if isinstance(x, (int, float, np.integer, np.floating)):
        return math.isfinite(float(x))
    return False


def clean(xs: Iterable[Num]) -> list[float]:
    """有限値だけを取り出す。None / NaN / inf を落とす。"""
    return [float(x) for x in xs if is_num(x)]


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def quantile(xs: Sequence[float], q: float) -> float | None:
    """分位点 (線形補間, R type-7)。空なら None。

    TS 側 `quantile()` と 1 対 1 対応。
    """
    if len(xs) == 0:
        return None
    if len(xs) == 1:
        return float(xs[0])
    s = sorted(float(x) for x in xs)
    pos = clamp(q, 0.0, 1.0) * (len(s) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return s[lo]
    return s[lo] + (pos - lo) * (s[hi] - s[lo])


def median(xs: Sequence[float]) -> float | None:
    return quantile(xs, 0.5)


def mad(xs: Sequence[float]) -> float | None:
    """中央絶対偏差。外れ値に強い散らばりの尺度。"""
    m = median(xs)
    if m is None:
        return None
    return median([abs(float(x) - m) for x in xs])


def winsorize(xs: Sequence[float], p: float = 0.05) -> list[float]:
    """分位点でのウィンザライズ。

    バリュエーション指標は PER 4000 倍のような極端値が普通に出る。Z スコアを
    取る前に必ず通して、1 銘柄の外れ値でセクター全体の順位がひっくり返るのを防ぐ。
    要素数 4 未満では上下 5% が同じ点を指してしまうので何もしない (TS 側と同じ)。
    """
    vals = [float(x) for x in xs]
    if len(vals) < 4:
        return vals
    lo = quantile(vals, p)
    hi = quantile(vals, 1.0 - p)
    if lo is None or hi is None:
        return vals
    return [clamp(v, lo, hi) for v in vals]


def zscores(
    xs: Sequence[Num],
    *,
    winsorize_at: float | None = None,
    robust: bool = False,
) -> list[float | None]:
    """クロスセクションの Z スコア。欠損は None のまま残す。

    欠損を 0 で埋めてはいけない。0 は「ピア群の平均ちょうど」という意味のある
    値なので、データが無い銘柄が「平均的な銘柄」として順位表の真ん中に並ぶ。

    有効値が 3 未満、または散らばりがほぼ 0 のときは全部 None を返す。
    2 銘柄の Z スコアは常に ±0.707 で、情報がゼロなのに数字だけ出てしまう。
    """
    idx: list[int] = []
    vals: list[float] = []
    for i, x in enumerate(xs):
        if is_num(x):
            idx.append(i)
            vals.append(float(x))

    out: list[float | None] = [None] * len(xs)
    if len(vals) < 3:
        return out

    w = winsorize(vals, winsorize_at) if winsorize_at else vals

    if robust:
        center = median(w)
        m = mad(w)
        # 正規分布で σ に一致するようスケールを合わせる
        scale = None if m is None else m * 1.4826
    else:
        center = float(np.mean(w))
        scale = float(np.std(w, ddof=1)) if len(w) >= 2 else None

    if center is None or scale is None or scale < 1e-12:
        return out

    # 生値ではなくウィンザライズ後の値から計算する (TS 側と同じ)
    for k, v in enumerate(w):
        out[idx[k]] = (v - center) / scale
    return out


def percentile_ranks(xs: Sequence[Num]) -> list[float | None]:
    """パーセンタイル順位 [0,100]。同値は平均順位。欠損は None。"""
    pairs = [(i, float(x)) for i, x in enumerate(xs) if is_num(x)]
    out: list[float | None] = [None] * len(xs)
    n = len(pairs)
    if n == 0:
        return out
    if n == 1:
        out[pairs[0][0]] = 50.0
        return out

    pairs.sort(key=lambda p: p[1])
    k = 0
    while k < n:
        j = k
        while j + 1 < n and pairs[j + 1][1] == pairs[k][1]:
            j += 1
        avg_rank = (k + j) / 2
        pct = (avg_rank / (n - 1)) * 100
        for t in range(k, j + 1):
            out[pairs[t][0]] = pct
        k = j + 1
    return out


def z_to_score(z: float | None) -> float | None:
    """Z スコアを 0-100 のスコアに写す。±2.5σ で飽和。

    線形に伸ばすと外れ値でスコアが 0 / 100 に張り付き、中間層の差が消える。
    """
    if not is_num(z):
        return None
    return js_round(clamp(50 + (float(z) / 2.5) * 50, 0, 100) * 10) / 10


def weighted_mean(items: Sequence[tuple[float | None, float]]) -> tuple[float | None, float]:
    """加重平均。値が None の要素は無視してウェイトを再正規化する。

    戻り値は (加重平均, 実際に使われたウェイト合計)。後者を捨ててはいけない —
    ファンダメンタルズが無い銘柄は使用ウェイトが 0.35 程度になり、
    ウェイト 1.0 の銘柄と同じ土俵で比較していないことを示す唯一の手掛かりになる。
    """
    acc = 0.0
    w = 0.0
    for value, weight in items:
        if is_num(value) and weight > 0:
            acc += float(value) * weight
            w += weight
    return (acc / w if w > 0 else None, w)
