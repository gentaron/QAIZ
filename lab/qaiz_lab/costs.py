"""取引コストモデル。

コストを「往復 0.1% の定数」で置くバックテストは、資産規模を上げたときに
何も変わらない。実際には規模を上げるとインパクトが効いて、ある規模から先は
リターンが消える。その境界 (キャパシティ) が分からないと、戦略を採用してよいか
判断できない。

    片道コスト(bps) = 手数料 + ハーフスプレッド + インパクト
    インパクト(bps) = coefficient × sqrt(注文代金 / ADV)

平方根則を使うのは、線形だと小口で過大・大口で過小になるため。ただし
**係数は文献的な当たりであって、この口座での実測ではない**。だからこそ
ストレステストで ×2 / ×3 を必ず回し、1 倍でしか成立しない戦略を弾く。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class CostModel:
    """片道コストの計算器。全て bps (1bp = 0.01%)。"""

    commission_bps: float = 5.0
    commission_floor_jpy: float = 0.0
    half_spread_bps: float = 5.0
    impact_coefficient_bps: float = 10.0
    borrow_annual_bps: float = 150.0
    lot_size: int = 100
    round_lots: bool = True
    config_id: str = "inline"
    #: ストレステスト用の倍率 (commission, spread, impact)
    multipliers: tuple[float, float, float] = (1.0, 1.0, 1.0)
    _source: dict = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------------ #

    @classmethod
    def from_json(cls, path: str | Path) -> CostModel:
        cfg = json.loads(Path(path).read_text(encoding="utf-8"))
        spread = cfg["spread"]
        if spread.get("use_tick_table"):
            raise NotImplementedError(
                "呼値階段モデル (use_tick_table) は未実装。黙って bps 近似に"
                "フォールバックすると、低位株のコストを大幅に過小評価したまま"
                "気付けなくなるので、実装するまでは明示的に落とす。"
            )
        return cls(
            commission_bps=float(cfg["commission"]["bps"]),
            commission_floor_jpy=float(cfg["commission"].get("floor_jpy", 0.0)),
            half_spread_bps=float(spread["bps"]),
            impact_coefficient_bps=float(cfg["impact"]["coefficient_bps"]),
            borrow_annual_bps=float(cfg["borrow"]["annual_fee_bps"]),
            lot_size=int(cfg["settlement"]["lot_size"]),
            round_lots=bool(cfg["settlement"]["round_lots"]),
            config_id=f"{Path(path).name}#{cfg.get('id', '?')}",
            _source=cfg,
        )

    def scaled(self, commission: float = 1.0, spread: float = 1.0, impact: float = 1.0) -> CostModel:
        """ストレステスト用に倍率を掛けた複製を返す。"""
        return CostModel(
            commission_bps=self.commission_bps * commission,
            commission_floor_jpy=self.commission_floor_jpy * commission,
            half_spread_bps=self.half_spread_bps * spread,
            impact_coefficient_bps=self.impact_coefficient_bps * impact,
            borrow_annual_bps=self.borrow_annual_bps,
            lot_size=self.lot_size,
            round_lots=self.round_lots,
            config_id=self.config_id,
            multipliers=(commission, spread, impact),
            _source=self._source,
        )

    # ------------------------------------------------------------------ #

    def impact_bps(self, trade_value_jpy, adv_jpy) -> np.ndarray:
        """平方根則のマーケットインパクト (bps)。

        ADV が欠損・0 の銘柄は「流動性不明」であり、インパクト 0 ではない。
        NaN を返して、後段でその銘柄を建てられないようにする。
        """
        tv = np.abs(np.asarray(trade_value_jpy, dtype=float))
        adv = np.asarray(adv_jpy, dtype=float)
        with np.errstate(divide="ignore", invalid="ignore"):
            participation = np.where((adv > 0) & np.isfinite(adv), tv / adv, np.nan)
        return self.impact_coefficient_bps * np.sqrt(participation)

    def one_way_bps(self, trade_value_jpy, adv_jpy) -> np.ndarray:
        """片道の合計コスト (bps)。"""
        tv = np.abs(np.asarray(trade_value_jpy, dtype=float))
        base = self.commission_bps + self.half_spread_bps
        total = base + self.impact_bps(tv, adv_jpy)

        if self.commission_floor_jpy > 0:
            with np.errstate(divide="ignore", invalid="ignore"):
                floor_bps = np.where(tv > 0, self.commission_floor_jpy / tv * 1e4, 0.0)
            total = total + np.maximum(0.0, floor_bps - self.commission_bps)
        return total

    def trade_cost_jpy(self, trade_value_jpy, adv_jpy) -> np.ndarray:
        tv = np.abs(np.asarray(trade_value_jpy, dtype=float))
        return tv * self.one_way_bps(tv, adv_jpy) / 1e4

    def borrow_cost_jpy(self, short_value_jpy, holding_days: float) -> np.ndarray:
        """空売りの貸株料。日数按分 (年 252 営業日)。"""
        sv = np.abs(np.asarray(short_value_jpy, dtype=float))
        return sv * (self.borrow_annual_bps / 1e4) * (holding_days / 252.0)

    def describe(self) -> dict:
        return {
            "config_id": self.config_id,
            "commission_bps": self.commission_bps,
            "half_spread_bps": self.half_spread_bps,
            "impact_coefficient_bps": self.impact_coefficient_bps,
            "borrow_annual_bps": self.borrow_annual_bps,
            "lot_size": self.lot_size,
            "round_lots": self.round_lots,
            "stress_multipliers": {
                "commission": self.multipliers[0],
                "spread": self.multipliers[1],
                "impact": self.multipliers[2],
            },
            "assumption": "全て仮定値。実測の約定履歴で較正するまでは目安でしかない。",
        }


def apply_lot_rounding(target_value_jpy: pd.DataFrame, price: pd.DataFrame, lot: int) -> pd.DataFrame:
    """売買単位 (原則 100 株) に丸めた建玉金額。

    端数を無視すると小口のキャパシティを過大評価する。100万円で 100 銘柄に
    等金額配分すると 1 銘柄 1 万円で、株価 3000 円の銘柄は 1 単元 30 万円なので
    そもそも建てられない。丸めた結果 0 単元になった銘柄は 0 になる。
    """
    if lot <= 1:
        return target_value_jpy
    unit_value = price * lot
    with np.errstate(divide="ignore", invalid="ignore"):
        units = np.floor(np.abs(target_value_jpy) / unit_value.replace(0, np.nan))
    return np.sign(target_value_jpy) * units * unit_value
