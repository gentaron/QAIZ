"""クロスセクショナル・ロングショートのバックテスト。

## 時間軸の約束

    シグナル日 D    … その日の判断締め切り時点の情報だけでスコアを作る
    約定日 E = D+L  … L = ExecutionConvention.execution_lag_sessions
    保有            … 次のリバランスの約定日 E' まで
    期間リターン     … P(E') / P(E) - 1

「D の終値でスコアを作り、D の終値で建てる」は実行不能なので実装していない
(`execution_lag_sessions=0` は `leakage.assert_label_alignment` で弾かれる)。

## コスト

回転率に比例させるのではなく、**銘柄ごとの発注代金**から計算する。
回転率×一定 bps だと、同じ回転率でも「大型株 10 銘柄」と「小型株 200 銘柄」で
コストが同じになってしまう。実際には後者のほうがインパクトで数倍高い。

## ドリフト

前回のウェイトは保有期間中に価格変動でずれる。ずれた後のウェイトと新しい
目標ウェイトの差が実際の発注量。これを無視して「毎回グロス 100% を建て直す」
と、回転率を最大 2 倍過大評価し、コストを過大に見積もる (保守側だが、
キャパシティ分析の結論が変わるので正しく計算する)。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .calendar import ExecutionConvention
from .costs import CostModel
from .leakage import assert_label_alignment
from .metrics import summary
from .portfolio import PortfolioConstraints
from .prices import PricePanel


@dataclass
class BacktestConfig:
    rebalance_days: int = 20
    capital_jpy: float = 10_000_000.0
    conv: ExecutionConvention = field(default_factory=ExecutionConvention)
    constraints: PortfolioConstraints = field(default_factory=PortfolioConstraints)
    #: シグナルを追加で何営業日遅らせるか (ストレステスト用。0 が既定)
    signal_delay_days: int = 0
    seed: int = 20260910


@dataclass
class BacktestResult:
    returns: pd.Series
    gross_returns: pd.Series
    turnover: pd.Series
    costs: pd.Series
    weights: pd.DataFrame
    stats: dict
    meta: dict

    def to_dict(self) -> dict:
        return {"stats": self.stats, "meta": self.meta}


def run_backtest(
    scores: pd.DataFrame,
    panel: PricePanel,
    cost_model: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    sectors: pd.Series | None = None,
    adv_window: int = 20,
    label: str = "strategy",
) -> BacktestResult:
    """スコア行列からロングショートのリターン系列を作る。

    Parameters
    ----------
    scores:
        index=シグナル日, columns=code。その日のクロスセクションスコア。
        欠損は「その銘柄はその日評価できない」であり、0 ではない。
    weight_fn:
        `(scores_row, sectors=, adv=, capital_jpy=, constraints=) -> weights` な関数。
        `portfolio.quantile_weights` などを部分適用して渡す。
    """
    cal = panel.calendar
    assert_label_alignment(pd.DatetimeIndex(scores.index), cal, config.conv.execution_lag_sessions)

    px = panel.price_for(config.conv.execution_price)
    adv = panel.adv(adv_window)

    # リバランス日: シグナルのある営業日を rebalance_days おきに拾う
    signal_dates = [d for d in scores.index if cal.position(d) is not None]
    if len(signal_dates) < 2:
        raise ValueError("シグナル日がカレンダー上に 2 日以上必要")
    rebal_dates = signal_dates[:: max(1, config.rebalance_days)]

    total_lag = config.conv.execution_lag_sessions + config.signal_delay_days
    rows: list[dict] = []
    weight_rows: dict[pd.Timestamp, pd.Series] = {}
    prev_w = pd.Series(0.0, index=scores.columns, dtype=float)
    skipped: list[str] = []

    for i, d in enumerate(rebal_dates[:-1]):
        entry = cal.shift(d, total_lag)
        nxt = rebal_dates[i + 1]
        exit_ = cal.shift(nxt, total_lag)
        if entry is None or exit_ is None or entry not in px.index or exit_ not in px.index:
            skipped.append(str(pd.Timestamp(d).date()))
            continue

        row = scores.loc[d]
        w = weight_fn(
            row,
            sectors=sectors,
            adv=adv.loc[entry] if entry in adv.index else None,
            capital_jpy=config.capital_jpy,
            constraints=config.constraints,
        ).reindex(scores.columns).fillna(0.0)

        p0 = px.loc[entry].reindex(scores.columns)
        p1 = px.loc[exit_].reindex(scores.columns)
        with np.errstate(divide="ignore", invalid="ignore"):
            period_ret = (p1 / p0 - 1.0).replace([np.inf, -np.inf], np.nan)

        # 価格が取れない銘柄には建てない (0 リターンで持つのは嘘)
        tradable = period_ret.notna() & p0.notna() & (p0 > 0)
        w = w.where(tradable, 0.0)
        gross = w.abs().sum()
        if gross <= 1e-12:
            skipped.append(str(pd.Timestamp(d).date()))
            continue
        # 1 を超えたときだけ縮める。1 未満へ引き上げ直すと、
        # 建てられない銘柄を外したぶんが残りの銘柄に集中し、
        # portfolio 側で当てた 1 銘柄上限・ADV 上限が解ける。
        if gross > 1.0 + 1e-12:
            w = w / gross

        # 発注量 = 目標ウェイト - ドリフト後の前回ウェイト
        delta = (w - prev_w).abs()
        trade_value = delta * config.capital_jpy
        adv_row = adv.loc[entry].reindex(scores.columns) if entry in adv.index else pd.Series(np.nan, index=scores.columns)
        cost_jpy = np.nan_to_num(
            cost_model.trade_cost_jpy(trade_value.to_numpy(), adv_row.to_numpy()), nan=0.0
        ).sum()

        holding_days = float(cal.position(exit_) - cal.position(entry))
        short_value = float(w[w < 0].abs().sum() * config.capital_jpy)
        borrow = float(np.nan_to_num(cost_model.borrow_cost_jpy(short_value, holding_days)))

        gross_ret = float((w * period_ret.fillna(0.0)).sum())
        cost_ret = (cost_jpy + borrow) / config.capital_jpy

        rows.append({
            "date": pd.Timestamp(nxt),
            "entry": entry,
            "exit": exit_,
            "gross_return": gross_ret,
            "cost": cost_ret,
            "net_return": gross_ret - cost_ret,
            "turnover": float(delta.sum() / 2.0),
            "n_long": int((w > 0).sum()),
            "n_short": int((w < 0).sum()),
            "holding_days": holding_days,
        })
        weight_rows[pd.Timestamp(d)] = w

        # 次の期の開始ウェイト = 価格変動でドリフトした後のウェイト
        drifted = w * (1.0 + period_ret.fillna(0.0))
        g = drifted.abs().sum()
        prev_w = drifted / g if g > 1e-12 else drifted * 0.0

    if not rows:
        raise ValueError(
            "有効なリバランス期間が 1 つも無い。価格系列とシグナルの日付が"
            "噛み合っていない可能性が高い。"
        )

    df = pd.DataFrame(rows).set_index("date")
    periods_per_year = 252.0 / max(1, config.rebalance_days)
    stats = summary(df["net_return"], turnover=df["turnover"], periods_per_year=int(round(periods_per_year)))
    stats_gross = summary(df["gross_return"], periods_per_year=int(round(periods_per_year)))

    meta = {
        "label": label,
        "n_rebalances": int(len(df)),
        "skipped_rebalances": len(skipped),
        "skipped_sample": skipped[:5],
        "rebalance_days": config.rebalance_days,
        "capital_jpy": config.capital_jpy,
        "execution": config.conv.describe(),
        "signal_delay_days": config.signal_delay_days,
        "cost_model": cost_model.describe(),
        "price_adjustment_mode": panel.adjustment_mode,
        "turnover_source": panel.turnover.attrs.get("mode", "unknown"),
        "gross_stats": stats_gross,
        "cost_drag_annual": float(df["cost"].mean() * periods_per_year),
        "constraints": {
            "max_position": config.constraints.max_position,
            "max_sector_net": config.constraints.max_sector_net,
            "max_adv_participation": config.constraints.max_adv_participation,
            "dollar_neutral": config.constraints.dollar_neutral,
        },
        "seed": config.seed,
    }

    return BacktestResult(
        returns=df["net_return"],
        gross_returns=df["gross_return"],
        turnover=df["turnover"],
        costs=df["cost"],
        weights=pd.DataFrame(weight_rows).T if weight_rows else pd.DataFrame(),
        stats=stats,
        meta=meta,
    )


def capacity_curve(
    scores: pd.DataFrame,
    panel: PricePanel,
    cost_model: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    capitals: list[float],
    sectors: pd.Series | None = None,
) -> pd.DataFrame:
    """資産規模ごとに回してキャパシティ曲線を作る。

    小口では効かなかった流動性制約とインパクトが、規模を上げると効き始める。
    シャープが落ち始める点がその戦略のキャパシティ。無限に儲かる戦略は無い、
    という当たり前のことを数字で確認する工程。
    """
    rows = []
    for cap in capitals:
        cfg = BacktestConfig(
            rebalance_days=config.rebalance_days,
            capital_jpy=cap,
            conv=config.conv,
            constraints=config.constraints,
            signal_delay_days=config.signal_delay_days,
            seed=config.seed,
        )
        try:
            res = run_backtest(scores, panel, cost_model, cfg, weight_fn=weight_fn,
                               sectors=sectors, label=f"capital={cap:,.0f}")
            rows.append({
                "capital_jpy": cap,
                "sharpe": res.stats["sharpe"],
                "annual_return": res.stats["annual_return"],
                "cost_drag_annual": res.meta["cost_drag_annual"],
                "turnover_mean": res.stats.get("turnover_mean"),
                "max_drawdown": res.stats["max_drawdown"],
            })
        except ValueError as e:
            rows.append({"capital_jpy": cap, "sharpe": None, "error": str(e)[:120]})
    return pd.DataFrame(rows)
