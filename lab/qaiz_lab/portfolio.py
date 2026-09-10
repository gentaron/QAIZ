"""ポートフォリオ構築。

予測値をそのまま売買しない。スコア上位を等金額で買うだけの実装は、
気付かないうちに以下を全部やっている:

  - 特定業種に 60% 集中する (業種ローテーションを買っているだけ)
  - 小型株ばかり買う (サイズファクターを買っているだけ)
  - 出来高の 30% を叩く注文を出す (執行不能)
  - β 1.8 のロング × β 0.6 のショート (マーケットニュートラルを名乗れない)

このモジュールは中立化と制約を**シグナルとは別の層**として持つ。
分離しておくと「制約を入れると消えるアルファ」を発見できる。それは
アルファではなく制約違反だった、ということなので、発見できるほうがよい。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .xsection import zscores


@dataclass(frozen=True)
class PortfolioConstraints:
    """建玉制約。すべて config で変更できる。"""

    #: 1 銘柄の最大ウェイト (グロス比)
    max_position: float = 0.05
    #: 1 業種の最大ネットエクスポージャ (グロス比)
    max_sector_net: float = 0.20
    #: 建玉金額 / ADV の上限。0.05 なら「日次売買代金の 5% まで」
    max_adv_participation: float = 0.05
    #: ロングとショートのグロスを揃えるか (ダラーニュートラル)
    dollar_neutral: bool = True
    #: 1 回のリバランスで許す片道回転率の上限 (グロス比)。None で無制限
    max_turnover: float | None = None


def neutralize(
    scores: pd.Series,
    *,
    sectors: pd.Series | None = None,
    size: pd.Series | None = None,
    beta: pd.Series | None = None,
    min_names_per_sector: int = 5,
) -> pd.Series:
    """スコアを業種・サイズ・β に対して中立化する。

    やり方はクロスセクション回帰の残差を取ること:

        score = a + Σ b_s · 業種ダミー_s + c · log(時価総額) + d · β + 残差

    残差が「業種・サイズ・β では説明できない部分」になる。中立化前後を並べて
    効果が消えるなら、元のシグナルはそれらの既知ファクターの再発見だった、
    という結論になる。消えることは失敗ではなく、**正しい発見**である。

    銘柄数が少ない業種はダミーを立てない (立てるとその業種の残差が定義上 0 になり、
    「中立化したら消えた」のではなく「中立化で潰した」だけになる)。
    """
    y = pd.to_numeric(scores, errors="coerce")
    valid = y.notna()
    if valid.sum() < 10:
        return pd.Series(np.nan, index=scores.index, dtype=float)

    parts: list[pd.DataFrame] = []

    if sectors is not None:
        sec = sectors.reindex(y.index)
        counts = sec[valid].value_counts()
        keep = counts[counts >= min_names_per_sector].index
        dummies = pd.get_dummies(sec.where(sec.isin(keep)), dtype=float)
        if dummies.shape[1] >= 2:
            # 定数項と完全共線にならないよう 1 本落とす
            parts.append(dummies.iloc[:, 1:])

    for name, series in (("size", size), ("beta", beta)):
        if series is None:
            continue
        v = pd.to_numeric(series.reindex(y.index), errors="coerce")
        if name == "size":
            v = np.log(v.where(v > 0))
        z = pd.Series(zscores(v.tolist(), winsorize_at=0.05), index=y.index, dtype=float)
        parts.append(z.to_frame(name))

    if not parts:
        return y

    X = pd.concat(parts, axis=1)
    rows = valid & X.notna().all(axis=1)
    if rows.sum() < max(10, X.shape[1] + 5):
        # 説明変数が欠損だらけで回帰が立たない。埋めて回すより返さないほうがよい
        return pd.Series(np.nan, index=scores.index, dtype=float)

    A = np.column_stack([np.ones(int(rows.sum())), X[rows].to_numpy(dtype=float)])
    b = y[rows].to_numpy(dtype=float)
    coef, *_ = np.linalg.lstsq(A, b, rcond=None)
    resid = b - A @ coef

    out = pd.Series(np.nan, index=scores.index, dtype=float)
    out[rows] = resid
    return out


def quantile_weights(
    scores: pd.Series,
    *,
    quantiles: int = 5,
    long_quantile: int | None = None,
    short_quantile: int | None = 1,
    constraints: PortfolioConstraints | None = None,
    sectors: pd.Series | None = None,
    adv: pd.Series | None = None,
    capital_jpy: float | None = None,
) -> pd.Series:
    """分位ポートフォリオのウェイトを作る (グロス合計 = 1)。

    既定は「最上位分位をロング、最下位分位をショート」のロングショート。
    分位に満たない (有効銘柄が quantiles×2 未満) 日は全部 0 を返す。
    """
    constraints = constraints or PortfolioConstraints()
    long_quantile = quantiles if long_quantile is None else long_quantile
    s = pd.to_numeric(scores, errors="coerce").dropna()
    zero = pd.Series(0.0, index=scores.index, dtype=float)
    if len(s) < quantiles * 2:
        return zero

    # 同値が多いと qcut が落ちるので順位に直してから切る
    ranks = s.rank(method="first")
    bins = pd.qcut(ranks, quantiles, labels=False, duplicates="drop") + 1
    if bins.nunique() < quantiles:
        return zero

    w = pd.Series(0.0, index=s.index, dtype=float)
    longs = bins[bins == long_quantile].index
    shorts = bins[bins == short_quantile].index if short_quantile else pd.Index([])

    if len(longs) == 0:
        return zero
    w[longs] = 1.0 / len(longs)
    if len(shorts) > 0:
        w[shorts] = -1.0 / len(shorts)

    w = _apply_constraints(w, constraints=constraints, sectors=sectors, adv=adv, capital_jpy=capital_jpy)
    return w.reindex(scores.index).fillna(0.0)


def score_weights(
    scores: pd.Series,
    *,
    constraints: PortfolioConstraints | None = None,
    sectors: pd.Series | None = None,
    adv: pd.Series | None = None,
    capital_jpy: float | None = None,
) -> pd.Series:
    """Z スコア比例のロングショート (分位で切らない版)。

    分位に切ると境界の 1 銘柄の出入りで回転率が跳ねる。連続ウェイトのほうが
    回転率は落ち着くが、上下の極端な銘柄に効きにくい。両方を比較するために
    2 つ用意してある。
    """
    constraints = constraints or PortfolioConstraints()
    z = pd.Series(zscores(pd.to_numeric(scores, errors="coerce").tolist(), winsorize_at=0.05),
                  index=scores.index, dtype=float)
    z = z - z.mean(skipna=True)  # クロスセクションでネット 0 にする
    gross = z.abs().sum()
    if not np.isfinite(gross) or gross < 1e-12:
        return pd.Series(0.0, index=scores.index, dtype=float)
    w = (z / gross).fillna(0.0)
    return _apply_constraints(w, constraints=constraints, sectors=sectors, adv=adv, capital_jpy=capital_jpy)


def _apply_constraints(
    w: pd.Series,
    *,
    constraints: PortfolioConstraints,
    sectors: pd.Series | None,
    adv: pd.Series | None,
    capital_jpy: float | None,
) -> pd.Series:
    """制約を順に当てる。

    **当てた後にグロスを 1 へ引き上げ直さない。** 引き上げると制約が解ける:
    20 銘柄・5 分位なら上下 4 銘柄ずつで 1 銘柄 0.25、上限 10% で切って
    グロス 0.8、そこで 1 に戻すと 1 銘柄 0.125 になり上限を超える。

    制約が縛った結果グロスが 1 未満になるのは正しい状態で、
    残りは現金として持っている、という意味になる。逆にグロスが 1 を
    超えることは許さない (レバレッジをかけない前提)。
    """
    w = w.astype(float).copy()

    # 制約を当てる前にグロス 1 へ正規化しておく。以降は縮める方向にしか動かない。
    gross0 = w.abs().sum()
    if gross0 > 1e-12:
        w = w / gross0

    # 1) 流動性上限: 建玉金額が ADV の一定割合を超えないようにする
    if adv is not None and capital_jpy is not None and constraints.max_adv_participation > 0:
        cap_value = pd.to_numeric(adv.reindex(w.index), errors="coerce") * constraints.max_adv_participation
        cap_weight = (cap_value / capital_jpy).clip(lower=0.0)
        # ADV 不明の銘柄は建てない。0 として扱うと「制約なし」になってしまう
        cap_weight = cap_weight.fillna(0.0)
        w = np.sign(w) * np.minimum(w.abs(), cap_weight)

    # 2) 1 銘柄上限
    if constraints.max_position > 0:
        w = np.sign(w) * np.minimum(w.abs(), constraints.max_position)

    # 3) 業種ネットエクスポージャ上限
    if sectors is not None and constraints.max_sector_net > 0:
        sec = sectors.reindex(w.index)
        for idx in sec.groupby(sec).groups.values():
            idx = [i for i in idx if i in w.index]
            net = w[idx].sum()
            if abs(net) > constraints.max_sector_net and abs(net) > 1e-12:
                w[idx] = w[idx] * (constraints.max_sector_net / abs(net))

    # 4) ダラーニュートラル化
    if constraints.dollar_neutral:
        longs, shorts = w[w > 0], w[w < 0]
        if len(longs) > 0 and len(shorts) > 0:
            gl, gs = longs.sum(), -shorts.sum()
            target = min(gl, gs)
            if gl > 1e-12:
                w[w > 0] = longs * (target / gl)
            if gs > 1e-12:
                w[w < 0] = shorts * (target / gs)

    # 縮める方向にのみ最終調整する (グロス 1 超はレバレッジなので許さない)
    gross = w.abs().sum()
    return w / gross if gross > 1.0 + 1e-12 else w


def exposures(w: pd.Series, factors: pd.DataFrame) -> dict[str, float | None]:
    """ポートフォリオのファクターエクスポージャ。

    「マーケットニュートラル」を名乗る前にこれを見る。ネット 0 でも
    β が 0.4 残っていれば、それは市場を 40% 持っているのと同じ。
    """
    out: dict[str, float | None] = {"net": float(w.sum()), "gross": float(w.abs().sum())}
    for col in factors.columns:
        v = pd.to_numeric(factors[col].reindex(w.index), errors="coerce")
        mask = v.notna() & (w != 0)
        out[col] = float((w[mask] * v[mask]).sum()) if mask.any() else None
    return out
