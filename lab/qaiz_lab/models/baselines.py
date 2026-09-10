"""ベースラインモデル。

## いきなり LightGBM を回さない

「LightGBM のシャープが 1.2 でした」には情報が無い。モメンタム単体が 1.1 なら、
LightGBM はモメンタムを再現しているだけかもしれない。ベースラインを先に
置いておかないと、そもそも比較する相手が無い。

必須のベースライン (README 20, 40):

    equal_weight … ユニバース等ウェイト。手数料だけ払う「何もしない」戦略
    random       … シード固定の乱数スコア。**これに勝てない戦略は無価値**
    momentum     … 12-1 モメンタム
    reversal     … 短期反転
    ridge        … 線形。numpy の閉形式で解く (依存なし)

`random` を必ず含めるのが重要。乱数ベースラインのシャープがゼロ近傍に
ならないなら、それは戦略の問題ではなく**評価系の問題**である
(バックテストのバグ、生存者バイアス、コストの入れ忘れなど)。
評価系の健全性チェックとして毎回回す。

## sklearn は任意依存

Ridge は閉形式なので numpy だけで解ける。Lasso / ElasticNet / 勾配ブースティングが
必要になったら sklearn / LightGBM を入れる (どちらも無料・OSS)。
入っていなければ `NotImplementedError` で止まる — 黙って Ridge に
フォールバックしない。フォールバックすると実験ログのモデル名が嘘になる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..features import price as price_features
from ..prices import PricePanel
from ..xsection import zscores


def equal_weight_scores(panel: PricePanel) -> pd.DataFrame:
    """全銘柄同スコア。ロングオンリー等ウェイトのベンチマークになる。"""
    px = panel.adj_close
    return pd.DataFrame(1.0, index=px.index, columns=px.columns).where(px.notna())


def random_scores(panel: PricePanel, seed: int = 20260910) -> pd.DataFrame:
    """シード固定の乱数スコア。評価系の健全性チェック用。"""
    px = panel.adj_close
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        rng.standard_normal(px.shape), index=px.index, columns=px.columns
    ).where(px.notna())


def momentum_scores(panel: PricePanel, lookback: int = 252, skip: int = 20) -> pd.DataFrame:
    return price_features.momentum(panel, lookback, skip)


def reversal_scores(panel: PricePanel, lookback: int = 5) -> pd.DataFrame:
    return price_features.reversal(panel, lookback)


def low_vol_scores(panel: PricePanel, window: int = 60) -> pd.DataFrame:
    """低ボラは「ボラが小さいほど良い」ので符号を反転する。"""
    return -price_features.volatility(panel, window)


def cross_sectional_zscore(frame: pd.DataFrame, *, robust: bool = True) -> pd.DataFrame:
    """各日のクロスセクションを Z 化する (Worker 側と同じ定義)。"""
    out = {}
    for d, row in frame.iterrows():
        out[d] = pd.Series(
            zscores(row.tolist(), winsorize_at=0.05, robust=robust),
            index=frame.columns, dtype=float,
        )
    return pd.DataFrame(out).T.reindex(frame.index)


class CrossSectionalRidge:
    """日次クロスセクション回帰の Ridge (numpy 閉形式)。

        w = (XᵀX + λI)⁻¹ Xᵀy

    学習期間の全断面をプールして 1 本の係数を推定する。断面ごとに推定すると
    銘柄数ぶんしかサンプルが無く、係数が毎日暴れる。

    **特徴量は必ず日次でクロスセクション Z 化してから渡す。** 生値のまま
    プールすると、市場全体が動いた日の水準差が係数に乗る。
    """

    def __init__(self, alpha: float = 1.0):
        self.alpha = alpha
        self.coef_: np.ndarray | None = None
        self.feature_names_: list[str] = []

    def fit(self, features: dict[str, pd.DataFrame], target: pd.DataFrame) -> CrossSectionalRidge:
        X, y, names = _stack(features, target)
        if len(y) < 50:
            raise ValueError(f"学習サンプルが {len(y)} 件しかない。Ridge を当てる意味が無い。")
        n_feat = X.shape[1]
        A = X.T @ X + self.alpha * np.eye(n_feat)
        self.coef_ = np.linalg.solve(A, X.T @ y)
        self.feature_names_ = names
        return self

    def predict(self, features: dict[str, pd.DataFrame]) -> pd.DataFrame:
        if self.coef_ is None:
            raise RuntimeError("fit していないモデルで predict を呼んだ")
        first = features[self.feature_names_[0]]
        out = pd.DataFrame(0.0, index=first.index, columns=first.columns)
        valid = pd.DataFrame(True, index=first.index, columns=first.columns)
        for k, name in enumerate(self.feature_names_):
            f = features[name].reindex(index=first.index, columns=first.columns)
            out = out + self.coef_[k] * f.fillna(0.0)
            valid &= f.notna()
        # 1 つでも特徴量が欠けている銘柄は予測しない。0 で埋めて予測すると
        # 「情報が無い = 平均的」という誤ったスコアが付く。
        return out.where(valid)

    def coefficients(self) -> dict[str, float]:
        if self.coef_ is None:
            return {}
        return {n: float(c) for n, c in zip(self.feature_names_, self.coef_, strict=False)}


def _stack(features: dict[str, pd.DataFrame], target: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, list[str]]:
    names = sorted(features)
    base = features[names[0]]
    dates = base.index
    for n in names[1:]:
        dates = dates.intersection(features[n].index)
    dates = dates.intersection(target.index)

    cols = base.columns
    for n in names[1:]:
        cols = cols.intersection(features[n].columns)
    cols = cols.intersection(target.columns)

    mats = [features[n].loc[dates, cols].to_numpy(dtype=float).ravel() for n in names]
    X = np.column_stack(mats)
    y = target.loc[dates, cols].to_numpy(dtype=float).ravel()

    mask = np.isfinite(y) & np.isfinite(X).all(axis=1)
    return X[mask], y[mask], names


def require_sklearn(model_name: str):
    """sklearn 依存のモデルを使うときのガード。"""
    try:
        import sklearn  # noqa: F401
    except ImportError as e:
        raise NotImplementedError(
            f"{model_name} は scikit-learn を必要とする (無料・OSS)。\n"
            "  pip install scikit-learn\n"
            "入っていない状態で Ridge に黙って落とすと、実験ログのモデル名が"
            "実際に走ったモデルと食い違う。"
        ) from e
