"""検証層。バックテストの結果を疑うための道具一式。

    ic          … クロスセクショナル予測力 (IC / ICIR / 減衰)
    quantiles   … 単変量分位ポートフォリオ (単調性の確認)
    splits      … Walk-Forward / Purged K-Fold (embargo つき)
    overfitting … Deflated Sharpe / PBO (試行回数の割り引き)
    stress      … コスト・遅延・欠損・パラメータ感度・レジーム分割
"""

from .ic import cross_sectional_ic, ic_decay, ic_summary, newey_west_t
from .overfitting import (
    cscv_pbo,
    deflated_sharpe_ratio,
    expected_max_sharpe,
    probabilistic_sharpe_ratio,
)
from .quantiles import monotonicity, quantile_returns, quantile_summary
from .splits import Split, purged_kfold, walk_forward
from .stress import (
    cost_stress,
    delay_stress,
    missing_data_stress,
    parameter_sensitivity,
    regime_split,
)

__all__ = [
    "cross_sectional_ic", "ic_summary", "ic_decay", "newey_west_t",
    "quantile_returns", "quantile_summary", "monotonicity",
    "walk_forward", "purged_kfold", "Split",
    "deflated_sharpe_ratio", "probabilistic_sharpe_ratio", "expected_max_sharpe", "cscv_pbo",
    "cost_stress", "delay_stress", "missing_data_stress", "parameter_sensitivity", "regime_split",
]
