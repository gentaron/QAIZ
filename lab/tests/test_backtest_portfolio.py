"""ポートフォリオ構築とバックテストのテスト。"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qaiz_lab.backtest import BacktestConfig, capacity_curve, run_backtest
from qaiz_lab.calendar import ExecutionConvention
from qaiz_lab.costs import CostModel
from qaiz_lab.leakage import LeakageError
from qaiz_lab.portfolio import (
    PortfolioConstraints,
    exposures,
    neutralize,
    quantile_weights,
    score_weights,
)
from qaiz_lab.prices import build_price_panel
from qaiz_lab.providers.synthetic import SyntheticConfig, make_market
from qaiz_lab.universe import UniverseRules, build_universe


@pytest.fixture(scope="module")
def market():
    return make_market(SyntheticConfig(n_codes=50, n_days=420, margin_effect=0.0, seed=99))


@pytest.fixture(scope="module")
def panel(market):
    return build_price_panel(market["bars"])


# ------------------------------------------------------ ウェイト構築 --


def test_quantile_weights_are_dollar_neutral_and_gross_one() -> None:
    scores = pd.Series(np.arange(50, dtype=float), index=[f"C{i}" for i in range(50)])
    w = quantile_weights(scores, quantiles=5, constraints=PortfolioConstraints(max_position=1.0))
    assert w.abs().sum() == pytest.approx(1.0, abs=1e-9)
    assert w.sum() == pytest.approx(0.0, abs=1e-9)
    assert (w > 0).sum() == 10 and (w < 0).sum() == 10


def test_position_cap_reduces_gross_instead_of_reconcentrating() -> None:
    """上限で切った結果グロスが 1 未満になるのは正しい状態。

    ここで 1 に戻すと、切ったはずのウェイトが残りの銘柄に集中して
    上限が解ける (制約を当てた意味が消える)。残りは現金として持つ。
    """
    scores = pd.Series(np.arange(20, dtype=float), index=[f"C{i}" for i in range(20)])
    w = quantile_weights(scores, quantiles=5,
                         constraints=PortfolioConstraints(max_position=0.10))
    assert w.abs().max() <= 0.10 + 1e-9
    assert w.abs().sum() == pytest.approx(0.8, abs=1e-9)
    assert w.abs().sum() < 1.0


def test_max_position_constraint_is_enforced() -> None:
    scores = pd.Series(np.arange(20, dtype=float), index=[f"C{i}" for i in range(20)])
    w = quantile_weights(scores, quantiles=5,
                         constraints=PortfolioConstraints(max_position=0.10))
    assert w.abs().max() <= 0.10 + 1e-9


def test_adv_constraint_blocks_illiquid_names() -> None:
    """ADV 不明の銘柄には建てない (制約なしにしない)。"""
    codes = [f"C{i}" for i in range(20)]
    scores = pd.Series(np.arange(20, dtype=float), index=codes)
    adv = pd.Series([np.nan] * 10 + [1e12] * 10, index=codes)
    w = quantile_weights(
        scores, quantiles=5, adv=adv, capital_jpy=1e7,
        constraints=PortfolioConstraints(max_adv_participation=0.05),
    )
    assert w[codes[:10]].abs().sum() == 0.0, "ADV 不明の銘柄に建玉が入っている"


def test_sector_exposure_constraint() -> None:
    codes = [f"C{i}" for i in range(30)]
    scores = pd.Series(np.arange(30, dtype=float), index=codes)
    # 上位も下位も同じ業種に偏らせる
    sectors = pd.Series(["S1"] * 30, index=codes)
    w = quantile_weights(scores, quantiles=5, sectors=sectors,
                         constraints=PortfolioConstraints(max_sector_net=0.10))
    assert abs(w.sum()) <= 0.10 + 1e-9


def test_score_weights_are_cross_sectionally_neutral() -> None:
    scores = pd.Series(np.random.default_rng(1).standard_normal(60),
                       index=[f"C{i}" for i in range(60)])
    w = score_weights(scores)
    assert abs(w.sum()) < 1e-9
    assert w.abs().sum() == pytest.approx(1.0, abs=1e-9)


# ------------------------------------------------------------ 中立化 --


def test_neutralization_removes_sector_effect() -> None:
    """業種ダミーで説明できる成分が残差から消えること。"""
    codes = [f"C{i}" for i in range(60)]
    sectors = pd.Series([f"S{i % 4}" for i in range(60)], index=codes)
    # スコアが完全に業種で決まる系列
    raw = pd.Series([{"S0": 3.0, "S1": 1.0, "S2": -1.0, "S3": -3.0}[s] for s in sectors],
                    index=codes)
    resid = neutralize(raw, sectors=sectors)
    assert resid.abs().max() < 1e-8, (
        "業種だけで決まるスコアが業種中立化後も残っている"
    )


def test_neutralization_keeps_idiosyncratic_component() -> None:
    codes = [f"C{i}" for i in range(60)]
    sectors = pd.Series([f"S{i % 4}" for i in range(60)], index=codes)
    rng = np.random.default_rng(4)
    idio = pd.Series(rng.standard_normal(60), index=codes)
    raw = pd.Series([{"S0": 3.0, "S1": 1.0, "S2": -1.0, "S3": -3.0}[s] for s in sectors],
                    index=codes) + idio
    resid = neutralize(raw, sectors=sectors)
    assert resid.std() > 0.5, "個別成分まで潰されている"
    assert resid.corr(idio) > 0.95


def test_neutralization_skips_thin_sectors() -> None:
    """銘柄数が足りない業種はダミーを立てない (残差が定義上 0 になるのを防ぐ)。"""
    codes = [f"C{i}" for i in range(20)]
    sectors = pd.Series(["S0"] * 17 + ["S1", "S2", "S3"], index=codes)
    raw = pd.Series(np.arange(20, dtype=float), index=codes)
    resid = neutralize(raw, sectors=sectors, min_names_per_sector=5)
    assert resid.notna().sum() >= 15


def test_exposures_reports_residual_beta() -> None:
    codes = [f"C{i}" for i in range(10)]
    w = pd.Series([0.1] * 5 + [-0.1] * 5, index=codes)
    factors = pd.DataFrame({"beta": [1.5] * 5 + [0.5] * 5}, index=codes)
    e = exposures(w, factors)
    assert e["net"] == pytest.approx(0.0, abs=1e-12)
    assert e["beta"] == pytest.approx(0.5, abs=1e-9), (
        "ネット 0 でも β が残っていることを検出できていない"
    )


# ------------------------------------------------------ バックテスト --


def test_backtest_rejects_same_day_execution(panel) -> None:
    scores = pd.DataFrame(1.0, index=panel.dates[:100], columns=panel.codes)
    cfg = BacktestConfig(conv=ExecutionConvention(execution_lag_sessions=0))
    with pytest.raises(LeakageError):
        run_backtest(scores, panel, CostModel(), cfg, weight_fn=quantile_weights)


def test_backtest_costs_reduce_returns(panel) -> None:
    rng = np.random.default_rng(3)
    scores = pd.DataFrame(
        rng.standard_normal((len(panel.dates), len(panel.codes))),
        index=panel.dates, columns=panel.codes,
    )
    cfg = BacktestConfig(rebalance_days=20, capital_jpy=1e7)
    res = run_backtest(scores, panel, CostModel(), cfg, weight_fn=quantile_weights)

    assert (res.costs >= 0).all(), "負のコストが発生している"
    assert (res.returns <= res.gross_returns + 1e-12).all(), (
        "ネットリターンがグロスを上回っている (コストが引かれていない)"
    )
    assert res.meta["cost_drag_annual"] > 0


def test_backtest_turnover_is_bounded(panel) -> None:
    rng = np.random.default_rng(8)
    scores = pd.DataFrame(
        rng.standard_normal((len(panel.dates), len(panel.codes))),
        index=panel.dates, columns=panel.codes,
    )
    res = run_backtest(scores, panel, CostModel(), BacktestConfig(rebalance_days=20),
                       weight_fn=quantile_weights)
    assert (res.turnover >= 0).all()
    assert (res.turnover <= 1.0 + 1e-9).all(), (
        "片道回転率が 100% を超えている (ドリフト計算がおかしい)"
    )


def test_random_signal_sharpe_is_near_zero(panel) -> None:
    """乱数シグナルのシャープがゼロ近傍になること。

    これが常にプラスに出るなら、戦略ではなく**評価系**が壊れている。
    """
    sharpes = []
    for seed in range(6):
        rng = np.random.default_rng(seed)
        scores = pd.DataFrame(
            rng.standard_normal((len(panel.dates), len(panel.codes))),
            index=panel.dates, columns=panel.codes,
        )
        res = run_backtest(scores, panel, CostModel(commission_bps=0, half_spread_bps=0,
                                                    impact_coefficient_bps=0, borrow_annual_bps=0),
                           BacktestConfig(rebalance_days=20), weight_fn=quantile_weights)
        if res.stats["sharpe"] is not None:
            sharpes.append(res.stats["sharpe"])

    assert len(sharpes) >= 4
    assert abs(float(np.mean(sharpes))) < 1.0, (
        f"乱数シグナルの平均シャープが {np.mean(sharpes):.2f}。"
        "評価系にバイアスが入っている疑いがある。"
    )


def test_capacity_degrades_at_large_size(panel) -> None:
    """規模を上げるとコストドラッグが増えること。"""
    rng = np.random.default_rng(12)
    scores = pd.DataFrame(
        rng.standard_normal((len(panel.dates), len(panel.codes))),
        index=panel.dates, columns=panel.codes,
    )
    curve = capacity_curve(
        scores, panel, CostModel(), BacktestConfig(rebalance_days=20),
        weight_fn=quantile_weights, capitals=[1e6, 1e10],
    )
    drags = curve["cost_drag_annual"].dropna()
    assert len(drags) == 2
    assert drags.iloc[-1] > drags.iloc[0], (
        "資産規模を 1万倍にしてもコストが増えていない (インパクトが効いていない)"
    )


def test_backtest_meta_records_assumptions(panel) -> None:
    """結果に前提が刻まれていること。刻まれていない結果は再現できない。"""
    scores = pd.DataFrame(
        np.random.default_rng(1).standard_normal((len(panel.dates), len(panel.codes))),
        index=panel.dates, columns=panel.codes,
    )
    res = run_backtest(scores, panel, CostModel(), BacktestConfig(rebalance_days=20),
                       weight_fn=quantile_weights)
    for key in ("execution", "cost_model", "price_adjustment_mode", "constraints", "seed",
                "turnover_source"):
        assert key in res.meta, f"meta に {key} が無い"
    assert "D+1" in res.meta["execution"] and "始値" in res.meta["execution"]


# -------------------------------------------------------- ユニバース --


def test_universe_flags_survivorship_when_no_delistings(panel, market) -> None:
    from qaiz_lab.providers import normalize

    listed = normalize.listed_frame(market["listed"])
    uni = build_universe(panel, UniverseRules(), listed=listed)
    assert uni.diagnostics["survivorship_bias"] == "PRESENT", (
        "上場廃止銘柄が 1 件も無いのに生存者バイアスを警告していない"
    )


def test_universe_masking_uses_nan_not_zero(panel) -> None:
    uni = build_universe(panel, UniverseRules())
    frame = pd.DataFrame(1.0, index=panel.dates, columns=panel.codes)
    masked = uni.masked(frame)
    excluded = masked.isna()
    assert excluded.any().any()
    assert not (masked == 0).any().any(), "ユニバース外が 0 で埋められている"
