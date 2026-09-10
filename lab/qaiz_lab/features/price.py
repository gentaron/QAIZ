"""価格由来の特徴量。

すべて「シグナル日 D の終値まで」で計算する。`shift()` を書き忘れると
その日の終値を使って売買することになるので、ここでは **PricePanel の
終値行列をそのまま使い、ラベル側で執行ラグを持つ** 方式に統一している。
特徴量側とラベル側の両方でラグを入れると二重にずれる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..prices import PricePanel
from .registry import REGISTRY, FeatureSpec

_PRICE_SRC = "日次OHLCV (調整済み終値)"
_AVAIL = "D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。"


def momentum(panel: PricePanel, lookback: int = 252, skip: int = 20) -> pd.DataFrame:
    """モメンタム。直近 `skip` 営業日を除いた `lookback` 日リターン。

    直近 1 ヶ月を除くのは短期反転効果を避けるため。除かないと
    「先月上がった銘柄」を買うことになり、日本株では逆効果になりやすい。
    """
    px = panel.adj_close
    past = px.shift(lookback)
    recent = px.shift(skip)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (recent / past - 1.0).replace([np.inf, -np.inf], np.nan)


def reversal(panel: PricePanel, lookback: int = 5) -> pd.DataFrame:
    """短期反転。直近 n 日リターンの符号を反転して返す。"""
    px = panel.adj_close
    with np.errstate(divide="ignore", invalid="ignore"):
        return -(px / px.shift(lookback) - 1.0).replace([np.inf, -np.inf], np.nan)


def volatility(panel: PricePanel, window: int = 60) -> pd.DataFrame:
    return panel.realized_vol(window)


def log_turnover(panel: PricePanel, window: int = 20) -> pd.DataFrame:
    """流動性 (対数売買代金)。サイズと強く相関するので中立化の対象。"""
    adv = panel.adv(window)
    return np.log(adv.where(adv > 0))


def size_proxy(panel: PricePanel, shares: pd.DataFrame | None = None) -> pd.DataFrame:
    """時価総額。発行済株式数が無ければ売買代金で代用する。

    代用したことを黙っていると、後で「サイズ中立化した」と言えなくなる。
    戻り値の `attrs["proxy"]` に何を使ったかを残す。
    """
    if shares is not None:
        mcap = panel.close * shares.reindex_like(panel.close)
        mcap.attrs["proxy"] = "close*shares_outstanding"
        return mcap
    out = panel.adv(20)
    out = out.copy()
    out.attrs["proxy"] = "ADV20 (時価総額の代用。真のサイズではない)"
    return out


def rolling_beta(panel: PricePanel, benchmark: pd.Series, window: int = 252) -> pd.DataFrame:
    """ベンチマークに対するローリング β。

    リターンは**日付を突き合わせてから**取る。末尾から n 本ずつ切り出すと
    休日のずれで系列が平行移動し、相関が構造的に過小評価される
    (これは Worker 側 `src/analytics/risk.ts` と同じ考え方)。
    """
    r = panel.returns()
    b = pd.Series(benchmark).reindex(r.index).astype(float)
    cov = r.rolling(window, min_periods=window // 2).cov(b)
    var = b.rolling(window, min_periods=window // 2).var(ddof=1)
    return cov.div(var, axis=0)


def register_price_features() -> None:
    REGISTRY.register(FeatureSpec(
        name="mom_12_1", category="momentum",
        definition="直近1ヶ月を除く12ヶ月リターン",
        source=_PRICE_SRC, lookback=252,
        calculation="P[t-20] / P[t-252] - 1",
        availability=_AVAIL,
        correlated_with=("mom_6_1",),
        notes="日本株では米国株よりモメンタムが弱いという先行研究がある。ベースラインとして必須。",
    ))
    REGISTRY.register(FeatureSpec(
        name="rev_5d", category="momentum",
        definition="5営業日リターンの符号反転 (短期反転)",
        source=_PRICE_SRC, lookback=5,
        calculation="-(P[t] / P[t-5] - 1)",
        availability=_AVAIL,
        notes="信用残シグナルと相関しやすい。R001 では必ず併記して比較する。",
    ))
    REGISTRY.register(FeatureSpec(
        name="vol_60d", category="volatility",
        definition="60営業日の実現ボラティリティ (年率)",
        source=_PRICE_SRC, lookback=60,
        calculation="std(日次リターン, 60) * sqrt(252)",
        availability=_AVAIL,
    ))
    REGISTRY.register(FeatureSpec(
        name="log_adv_20d", category="liquidity",
        definition="20営業日平均売買代金の対数",
        source=_PRICE_SRC, lookback=20,
        calculation="log(mean(売買代金, 20))",
        availability=_AVAIL,
        correlated_with=("size_mcap",),
        notes="サイズと相関 0.8 超になることが多い。両方入れると係数が不安定になる。",
    ))
    REGISTRY.register(FeatureSpec(
        name="beta_252d", category="price",
        definition="TOPIX に対する252日ローリングβ",
        source=_PRICE_SRC + " + ベンチマーク", lookback=252,
        calculation="cov(r, r_bm, 252) / var(r_bm, 252)",
        availability=_AVAIL,
    ))


register_price_features()
