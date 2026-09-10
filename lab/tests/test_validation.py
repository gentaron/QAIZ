"""検証層のテスト。

「疑うための道具」自体が壊れていたら、疑えたつもりになるだけで
何も検証していないことになる。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from qaiz_lab.validation.ic import cross_sectional_ic, ic_summary, newey_west_t
from qaiz_lab.validation.overfitting import (
    cscv_pbo,
    deflated_sharpe_ratio,
    expected_max_sharpe,
    norm_cdf,
    norm_ppf,
    probabilistic_sharpe_ratio,
)
from qaiz_lab.validation.quantiles import monotonicity, quantile_returns, quantile_summary
from qaiz_lab.validation.splits import purged_kfold, walk_forward


def _panel(n_days=200, n_codes=40, seed=7, signal_strength=0.0):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2022-01-03", periods=n_days)
    cols = [f"C{i:03d}" for i in range(n_codes)]
    s = pd.DataFrame(rng.standard_normal((n_days, n_codes)), index=idx, columns=cols)
    noise = pd.DataFrame(rng.standard_normal((n_days, n_codes)) * 0.02, index=idx, columns=cols)
    t = signal_strength * s * 0.02 + noise
    return s, t


# --------------------------------------------------------------- IC --


def test_ic_is_near_zero_for_unrelated_series() -> None:
    """無関係な系列で IC が 0 近傍になること。

    ここがゼロにならないなら、評価系自体が壊れている。
    """
    s, t = _panel(signal_strength=0.0)
    ic = cross_sectional_ic(s, t)
    assert abs(ic.mean()) < 0.05, f"無関係な系列で mean_ic={ic.mean():.4f}"


def test_ic_detects_planted_signal() -> None:
    s, t = _panel(signal_strength=3.0)
    ic = cross_sectional_ic(s, t)
    assert ic.mean() > 0.4, f"埋め込んだ信号を検出できていない (mean_ic={ic.mean():.4f})"


def test_ic_requires_minimum_cross_section() -> None:
    """銘柄数が足りない日は NaN。少数銘柄の相関を平均に混ぜない。"""
    s, t = _panel(n_codes=5)
    ic = cross_sectional_ic(s, t, min_names=20)
    assert ic.isna().all()


def test_newey_west_t_is_smaller_than_naive_for_overlapping_data() -> None:
    """重なりのある観測で、素朴な t より小さくなること。

    ホライズン 20 日を日次で評価すると 19 日ぶん重なる。素朴な t を
    そのまま読むと、有意でないものが有意に見える。
    """
    rng = np.random.default_rng(3)
    base = rng.standard_normal(600) * 0.05 + 0.02
    # 20 日移動平均で重なりを作る
    overlapping = pd.Series(base).rolling(20).mean().dropna()

    sd = overlapping.std(ddof=1)
    naive = overlapping.mean() / (sd / np.sqrt(len(overlapping)))
    nw = newey_west_t(overlapping, overlap=20)
    assert nw is not None
    assert abs(nw) < abs(naive), (
        f"Newey-West t={nw:.2f} が素朴な t={naive:.2f} より小さくなっていない"
    )


def test_ic_summary_reports_both_t_stats() -> None:
    s, t = _panel(signal_strength=1.0)
    out = ic_summary(cross_sectional_ic(s, t), overlap=20)
    assert out["t_stat_naive"] is not None
    assert out["t_stat_newey_west"] is not None
    assert out["overlap_days"] == 20


# -------------------------------------------------------- 分位分析 --


def test_quantile_spread_is_positive_for_planted_signal() -> None:
    s, t = _panel(signal_strength=3.0)
    qr = quantile_returns(s, t, quantiles=5)
    summary = quantile_summary(qr, quantiles=5)
    assert summary.loc["Q5", "mean_return"] > summary.loc["Q1", "mean_return"]
    mono = monotonicity(summary, quantiles=5)
    assert mono["monotonicity_spearman"] > 0.9


def test_quantile_summary_handles_empty_input() -> None:
    """分位が組めなかったこと自体が結果。0 を並べて誤魔化さない。"""
    out = quantile_summary(pd.DataFrame(), quantiles=5)
    assert out.empty
    assert "mean_return" in out.columns


# ------------------------------------------------------- 期間分割 --


def test_walk_forward_never_trains_on_the_future() -> None:
    dates = pd.bdate_range("2010-01-04", "2023-12-29")
    splits = walk_forward(dates, train_years=5, test_years=1, label_horizon_days=20)
    assert len(splits) >= 5
    for sp in splits:
        assert sp.train.max() < sp.test.min(), (
            f"訓練期間 (〜{sp.train.max().date()}) がテスト期間 "
            f"({sp.test.min().date()}〜) に食い込んでいる"
        )


def test_walk_forward_purges_label_overlap() -> None:
    """ラベルの重なりぶんが訓練末尾から削られていること。"""
    dates = pd.bdate_range("2010-01-04", "2020-12-31")
    horizon = 60
    splits = walk_forward(dates, train_years=5, test_years=1,
                          label_horizon_days=horizon, embargo_days=5)
    for sp in splits:
        gap_days = (sp.test.min() - sp.train.max()).days
        assert gap_days >= horizon, (
            f"訓練末尾とテスト開始の間隔が {gap_days} 日しかない "
            f"(ホライズン {horizon} 日ぶんの重なりが残っている)"
        )


def test_purged_kfold_embargoes_both_sides() -> None:
    dates = pd.bdate_range("2015-01-05", periods=800)
    splits = purged_kfold(dates, n_splits=5, label_horizon_days=20, embargo_days=5)
    assert len(splits) == 5
    for sp in splits:
        overlap = sp.train.intersection(sp.test)
        assert len(overlap) == 0, "訓練とテストが重なっている"
        near = sp.train[(sp.train > sp.test.min() - pd.Timedelta(days=10))
                        & (sp.train < sp.test.max() + pd.Timedelta(days=10))]
        assert len(near) == 0, "テスト前後の embargo が効いていない"


# ------------------------------------------------------ 過適合評価 --


def test_norm_ppf_matches_known_quantiles() -> None:
    assert norm_ppf(0.5) == pytest.approx(0.0, abs=1e-9)
    assert norm_ppf(0.975) == pytest.approx(1.959963985, abs=1e-7)
    assert norm_ppf(0.025) == pytest.approx(-1.959963985, abs=1e-7)
    assert norm_cdf(1.959963985) == pytest.approx(0.975, abs=1e-9)


def test_expected_max_sharpe_grows_with_trials() -> None:
    """試行回数を増やすほど、偶然到達するシャープの水準が上がること。"""
    a = expected_max_sharpe(10)
    b = expected_max_sharpe(1000)
    assert b > a > 0


def test_deflated_sharpe_rejects_lucky_backtest() -> None:
    """ノイズから 1000 回選んだ最良は「過適合」と判定されること。"""
    rng = np.random.default_rng(11)
    candidates = [pd.Series(rng.standard_normal(300) * 0.01) for _ in range(200)]
    best = max(candidates, key=lambda r: r.mean() / r.std(ddof=1))

    out = deflated_sharpe_ratio(best, n_trials=1000)
    assert out["dsr"] is not None
    assert out["dsr"] < 0.95, (
        f"ノイズから選んだ最良が DSR={out['dsr']:.3f} で有意扱いされている"
    )
    assert out["verdict"] in ("likely overfit", "inconclusive", "weak evidence")


def test_deflated_sharpe_accepts_genuinely_strong_signal() -> None:
    """本物に強い系列は、試行回数を割り引いても残ること。"""
    rng = np.random.default_rng(5)
    strong = pd.Series(rng.standard_normal(1500) * 0.01 + 0.004)
    out = deflated_sharpe_ratio(strong, n_trials=100)
    assert out["dsr"] > 0.95, f"強い系列が DSR={out['dsr']} で弾かれた"


def test_psr_below_one_for_marginal_series() -> None:
    rng = np.random.default_rng(2)
    weak = pd.Series(rng.standard_normal(200) * 0.01)
    psr = probabilistic_sharpe_ratio(weak, benchmark_sr=0.0)
    assert psr is not None and 0.0 <= psr <= 1.0


def test_cscv_pbo_is_high_for_pure_noise() -> None:
    """全戦略がノイズなら、「IS で最良を選ぶ」手続きに予測力は無い。"""
    rng = np.random.default_rng(19)
    perf = pd.DataFrame(
        rng.standard_normal((400, 12)) * 0.01,
        index=pd.bdate_range("2022-01-03", periods=400),
        columns=[f"S{i}" for i in range(12)],
    )
    out = cscv_pbo(perf, n_partitions=8)
    assert out["pbo"] is not None
    assert out["pbo"] > 0.25, f"ノイズだけの戦略群で PBO={out['pbo']:.2f} は低すぎる"
