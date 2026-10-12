"""ストレステストと感度分析。

戦略を殺しにいく工程。ここで壊れるなら、実運用でも壊れる。
順番に厳しくしていくのではなく、**全部一度に回して表にする**。
1 つずつ通していくと、途中で「まあこれくらいなら」が入り込む。

  コスト倍率     ×1 / ×2 / ×3
  シグナル遅延   +0 / +1 / +2 営業日
  欠損注入       1% / 5% / 10% をランダムに欠損させる
  パラメータ感度 lookback を 5/10/20/40/60/120 に振る
  レジーム分割   強気 / 弱気 / 高ボラ / 低ボラ

**シグナル遅延に最も注意する**。1 日遅らせただけで消える戦略は、
たいていリーケージか、約定不可能な瞬間の価格を掴んでいる。
コストを倍にして残るかより、こちらのほうが情報量が多い。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace

import numpy as np
import pandas as pd

from ..backtest import BacktestConfig, run_backtest
from ..costs import CostModel
from ..prices import PricePanel


def cost_stress(
    scores: pd.DataFrame,
    panel: PricePanel,
    base_cost: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    multipliers: tuple[float, ...] = (1.0, 2.0, 3.0),
    sectors: pd.Series | None = None,
) -> pd.DataFrame:
    """コスト倍率を振る。手数料・スプレッド・インパクトを同時に掛ける。"""
    rows = []
    for m in multipliers:
        cm = base_cost.scaled(commission=m, spread=m, impact=m)
        rows.append(_run_row(scores, panel, cm, config, weight_fn, sectors,
                             {"stress": "cost", "multiplier": m}))
    return pd.DataFrame(rows)


def delay_stress(
    scores: pd.DataFrame,
    panel: PricePanel,
    cost_model: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    delays: tuple[int, ...] = (0, 1, 2),
    sectors: pd.Series | None = None,
) -> pd.DataFrame:
    """シグナルを追加で n 営業日遅らせる。

    既定の執行規約 (翌営業日始値) に**さらに**足す遅延なので、
    delays=[0,1,2] は「翌日 / 翌々日 / 3 営業日後」に対応する。
    """
    rows = []
    for d in delays:
        cfg = replace(config, signal_delay_days=d)
        rows.append(_run_row(scores, panel, cost_model, cfg, weight_fn, sectors,
                             {"stress": "signal_delay", "extra_days": d}))
    return pd.DataFrame(rows)


def missing_data_stress(
    scores: pd.DataFrame,
    panel: PricePanel,
    cost_model: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    fractions: tuple[float, ...] = (0.0, 0.01, 0.05, 0.10),
    sectors: pd.Series | None = None,
    seed: int = 20260910,
) -> pd.DataFrame:
    """シグナルをランダムに欠損させる。

    現実のデータは落ちる。API が失敗し、銘柄がカバー外になり、
    公表が遅れる。欠損 5% で崩壊する戦略は運用に耐えない。
    seed 固定なので、同じ設定なら何度回しても同じ結果になる。
    """
    rows = []
    for f in fractions:
        rng = np.random.default_rng(seed)
        s = scores.copy()
        if f > 0:
            mask = rng.random(s.shape) < f
            s = s.mask(pd.DataFrame(mask, index=s.index, columns=s.columns))
        rows.append(_run_row(s, panel, cost_model, config, weight_fn, sectors,
                             {"stress": "missing_data", "fraction": f}))
    return pd.DataFrame(rows)


def parameter_sensitivity(
    build_scores: Callable[[int], pd.DataFrame],
    panel: PricePanel,
    cost_model: CostModel,
    config: BacktestConfig,
    *,
    weight_fn: Callable[..., pd.Series],
    lookbacks: tuple[int, ...] = (5, 10, 20, 40, 60, 120),
    sectors: pd.Series | None = None,
) -> pd.DataFrame:
    """lookback を振って性能の形を見る。

    **1 点だけ突出しているのは過適合のサイン**。lookback 20 でシャープ 1.8、
    その隣の 10 と 40 で 0.2 なら、20 が特別なのではなく 20 を選んだことが
    結果を作っている。滑らかな山になっているかを見る。
    """
    rows = []
    for lb in lookbacks:
        try:
            s = build_scores(lb)
        except Exception as e:  # noqa: BLE001 — どの lookback で落ちたかを残す
            rows.append({"stress": "lookback", "lookback": lb, "error": str(e)[:120]})
            continue
        rows.append(_run_row(s, panel, cost_model, config, weight_fn, sectors,
                             {"stress": "lookback", "lookback": lb}))
    df = pd.DataFrame(rows)
    if "sharpe" in df.columns and df["sharpe"].notna().sum() >= 3:
        df.attrs["overfitting_flag"] = _spike_flag(df["sharpe"])
    return df


def _spike_flag(sharpes: pd.Series) -> dict:
    """1 点突出の検出。最良値が 2 番目より大きく離れていたら警告。"""
    s = pd.to_numeric(sharpes, errors="coerce").dropna().sort_values(ascending=False)
    if len(s) < 3:
        return {"spike": None}
    best, second = float(s.iloc[0]), float(s.iloc[1])
    rest_std = float(s.iloc[1:].std(ddof=1)) if len(s) > 2 else 0.0
    gap = best - second
    return {
        "spike": bool(rest_std > 1e-9 and gap > 2.0 * rest_std),
        "best": best,
        "second": second,
        "gap": gap,
        "_note": "spike=True は、最良パラメータが他から浮いていることを意味する。過適合を疑う。",
    }


def regime_split(returns: pd.Series, regime: pd.Series) -> pd.DataFrame:
    """レジーム別のパフォーマンス。

    サンプル数を必ず一緒に出す。「弱気相場でシャープ 2.4」が 7 観測なら、
    それは発見ではなく偶然。
    """
    from ..metrics import summary

    r = pd.Series(returns).astype(float)
    g = pd.Series(regime).reindex(r.index)
    rows = []
    for name, idx in g.groupby(g).groups.items():
        sub = r.loc[r.index.intersection(pd.Index(idx))].dropna()
        s = summary(sub)
        s["regime"] = name
        s["reliable"] = bool(len(sub) >= 30)
        rows.append(s)
    df = pd.DataFrame(rows)
    return df.set_index("regime") if "regime" in df.columns else df


def _run_row(scores, panel, cost_model, config, weight_fn, sectors, tag: dict) -> dict:
    try:
        res = run_backtest(scores, panel, cost_model, config,
                           weight_fn=weight_fn, sectors=sectors, label=str(tag))
        return {
            **tag,
            "sharpe": res.stats["sharpe"],
            "annual_return": res.stats["annual_return"],
            "max_drawdown": res.stats["max_drawdown"],
            "turnover_mean": res.stats.get("turnover_mean"),
            "cost_drag_annual": res.meta["cost_drag_annual"],
            "n_rebalances": res.meta["n_rebalances"],
        }
    except Exception as e:  # noqa: BLE001 — 失敗も記録として残す
        return {**tag, "sharpe": None, "error": str(e)[:160]}
