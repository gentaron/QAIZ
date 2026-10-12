"""信用取引残高の特徴量 (Research 001)。

## 原系列は週次、シグナルは日次

信用残は原則として週次 (金曜申込日付) の観測で、翌週の第2営業日ごろに公表される。
つまり:

    月 火 水 木 金 | 月 火 水 木 金
                ↑基準日      ↑公表(第2営業日16:30)
                             ↑ここから使える

日次のパネルに載せる際は、`PITTable.asof_panel()` で
「available_at <= 判断時刻」を満たす最新の週次観測を引く。日付を単純に
forward-fill すると、公表前の期間にも値が入る。**これが R001 で最も
起きやすい未来情報の混入**であり、しかも IC が綺麗に出るので気付きにくい。

## 変化率をどう取るか

「5日変化」を暦の 5 日で取ると、週次系列では隣の観測との差になったり
同じ観測同士の差 (=0) になったりして不安定になる。ここでは **週次観測の
本数** で差を取る (5営業日 ≒ 1本、20営業日 ≒ 4本、60営業日 ≒ 12本)。
実装は `weeks_back` に換算してから `PITTable` 側で解決する。

## 混同してはいけないもの

  信用買残 (margin_long)    … 買い建てた未決済残高。将来の売り圧力
  信用売残 (margin_short)   … 売り建てた未決済残高。将来の買い戻し圧力
  空売り残高 (short_interest) … 制度信用の売残とは別物 (機関投資家の空売り報告)
  空売り比率 (short_ratio)  … 「出来高に占める空売りの割合」= フロー。残高ではない

残高 (ストック) とフローを混ぜると、意味の違う系列を平均することになる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..pit import PITTable
from .registry import REGISTRY, FeatureSpec

_MARGIN_SRC = "JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest)"
_MARGIN_AVAIL = (
    "基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。"
    "**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)**"
)

#: 週次観測 1 本 ≒ 5 営業日
SESSIONS_PER_WEEK = 5

MARGIN_VALUE_COLUMNS = ("margin_long", "margin_short")


def weeks_from_sessions(lookback_sessions: int) -> int:
    """営業日 lookback を週次観測の本数に直す。最低 1 本。"""
    return max(1, int(round(lookback_sessions / SESSIONS_PER_WEEK)))


def margin_panel(
    table: PITTable,
    decision_at: pd.Series,
    codes: list[str],
) -> pd.DataFrame:
    """信用残の PIT パネル (MultiIndex (date, code))。"""
    return table.asof_panel(decision_at, codes)


def _wide(panel: pd.DataFrame, col: str) -> pd.DataFrame:
    return panel[col].unstack("code")


def margin_change(
    panel: pd.DataFrame,
    column: str,
    lookback_sessions: int,
) -> pd.DataFrame:
    """信用残の変化率。

    週次観測を日次パネルに載せた後で日次の差を取ると、公表日だけ値が飛び、
    それ以外の日は 0 になる。それでは「公表日だけシグナルがある」ことになり、
    分位ポートフォリオが成立しない。
    そこで **観測本数ベースの差** を取る: 現在の as-of 値と、
    lookback 営業日前の as-of 値の比。
    """
    wide = _wide(panel, column)
    lag = wide.shift(lookback_sessions)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = (wide / lag.where(lag > 0) - 1.0)
    return out.replace([np.inf, -np.inf], np.nan)


def margin_ratio(panel: pd.DataFrame) -> pd.DataFrame:
    """信用倍率 = 買残 / 売残。

    売残 0 の銘柄は倍率が無限大になる。無限大を大きな数で埋めると、
    分位の最上位が「売残ゼロの銘柄」で埋まって別の現象を見ることになる。
    NaN のままにする。
    """
    long_ = _wide(panel, "margin_long")
    short = _wide(panel, "margin_short")
    with np.errstate(divide="ignore", invalid="ignore"):
        out = long_ / short.where(short > 0)
    return out.replace([np.inf, -np.inf], np.nan)


def scaled_by(panel: pd.DataFrame, column: str, denominator: pd.DataFrame) -> pd.DataFrame:
    """残高を ADV や時価総額で正規化する。

    生の残高 (株数・金額) はサイズと 0.9 以上相関する。正規化しないと
    「信用残の効果」ではなく「サイズファクター」を測ることになる。
    """
    wide = _wide(panel, column)
    den = denominator.reindex(index=wide.index, columns=wide.columns)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = wide / den.where(den > 0)
    return out.replace([np.inf, -np.inf], np.nan)


def build_r001_signals(
    panel: pd.DataFrame,
    *,
    adv: pd.DataFrame,
    market_cap: pd.DataFrame | None,
    lookbacks: list[int],
) -> dict[str, pd.DataFrame]:
    """`configs/research/r001_margin.json` の 7 シグナル × lookback を作る。

    market_cap が無い構成では `*_to_mktcap` を**作らない** (ADV で代用しない)。
    代用すると `*_to_adv` と同じものが 2 本並び、「独立な 7 シグナルを試した」
    という多重検定の勘定が狂う。
    """
    out: dict[str, pd.DataFrame] = {}

    for lb in lookbacks:
        out[f"margin_long_chg_{lb}d"] = margin_change(panel, "margin_long", lb)
        out[f"margin_short_chg_{lb}d"] = margin_change(panel, "margin_short", lb)

    out["margin_ratio"] = margin_ratio(panel)
    out["margin_long_to_adv"] = scaled_by(panel, "margin_long", adv)
    out["margin_short_to_adv"] = scaled_by(panel, "margin_short", adv)

    if market_cap is not None:
        out["margin_long_to_mktcap"] = scaled_by(panel, "margin_long", market_cap)
        out["margin_short_to_mktcap"] = scaled_by(panel, "margin_short", market_cap)

    return out


def register_margin_features() -> None:
    for lb in (5, 20, 60):
        w = weeks_from_sessions(lb)
        for side, ja in (("long", "買残"), ("short", "売残")):
            REGISTRY.register(FeatureSpec(
                name=f"margin_{side}_chg_{lb}d", category="margin",
                definition=f"信用{ja}の{lb}営業日 (≒{w}週) 変化率",
                source=_MARGIN_SRC, lookback=lb,
                calculation=f"asof(margin_{side})[t] / asof(margin_{side})[t-{lb}] - 1",
                availability=_MARGIN_AVAIL,
                correlated_with=(f"margin_{side}_chg_{'20' if lb != 20 else '60'}d",),
                notes="原系列は週次。lookback が 5日未満だと差が常に 0 になる。",
            ))

    REGISTRY.register(FeatureSpec(
        name="margin_ratio", category="margin",
        definition="信用倍率 = 信用買残 / 信用売残",
        source=_MARGIN_SRC, lookback=None,
        calculation="asof(margin_long) / asof(margin_short)",
        availability=_MARGIN_AVAIL,
        notes="売残0の銘柄は NaN。大きな数で埋めると分位上位が売残ゼロ銘柄で占められる。",
    ))
    for side, ja in (("long", "買残"), ("short", "売残")):
        REGISTRY.register(FeatureSpec(
            name=f"margin_{side}_to_adv", category="margin",
            definition=f"信用{ja} / 20日平均売買代金",
            source=_MARGIN_SRC + " + 日次OHLCV", lookback=20,
            calculation=f"asof(margin_{side}) / ADV20",
            availability=_MARGIN_AVAIL,
            correlated_with=(f"margin_{side}_to_mktcap",),
            notes="生の残高はサイズと0.9超で相関する。正規化しないとサイズを測ることになる。",
        ))
        REGISTRY.register(FeatureSpec(
            name=f"margin_{side}_to_mktcap", category="margin",
            definition=f"信用{ja} / 時価総額",
            source=_MARGIN_SRC + " + 銘柄マスター", lookback=None,
            calculation=f"asof(margin_{side}) / (終値 × 発行済株式数)",
            availability=_MARGIN_AVAIL,
            correlated_with=(f"margin_{side}_to_adv",),
            notes="発行済株式数が無い構成では作らない (ADVで代用しない)。",
        ))


register_margin_features()
