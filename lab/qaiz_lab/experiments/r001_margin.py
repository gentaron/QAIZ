"""Research 001 — 日本株における信用取引残高変化の将来超過リターン予測力。

事前登録: `configs/research/r001_margin.json`

## この実行が守ること

1. **仮説の符号を事前に決めていない**。正でも負でも「予想通り」にできる
   仮説は検証になっていないので、両側で評価する。
2. **中立化前後を必ず並べる**。業種・サイズ・β で消えるなら、それは
   信用残の効果ではなく既知ファクターの再発見である。
3. **試行回数を数える**。1008 通りの組み合わせを走らせて最良を見つけたら、
   その最良は偶然でも到達する。DSR で割り引く。
4. **完全 OOS を見ない**。`research_end` 以前だけで完結させ、
   final OOS は別コマンドで 1 回だけ実行する。
5. **データが無ければ実行しない**。信用残が取れない構成では
   `status=BLOCKED` で止まり、それらしい数字を出さない。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..backtest import BacktestConfig, capacity_curve, run_backtest
from ..calendar import ExecutionConvention
from ..config import CONFIG_DIR, RunContext, load_json, resolve_ref
from ..costs import CostModel
from ..features.margin import build_r001_signals, margin_panel
from ..labels import build_targets
from ..leakage import assert_available_at_respected, scan_panel_for_constant_future
from ..models import baselines
from ..pit import PITTable
from ..portfolio import PortfolioConstraints, neutralize, quantile_weights
from ..prices import build_price_panel
from ..providers import normalize
from ..universe import UniverseRules, build_universe
from ..validation import (
    cost_stress,
    cross_sectional_ic,
    deflated_sharpe_ratio,
    delay_stress,
    ic_summary,
    monotonicity,
    quantile_returns,
    quantile_summary,
)
from . import log as experiment_log


@dataclass
class R001Inputs:
    """R001 に必要な入力一式。プロバイダに依存しない形で受け取る。"""

    bars: pd.DataFrame
    margin_raw: pd.DataFrame
    sectors: pd.Series
    listed: pd.DataFrame | None = None
    shares_outstanding: pd.DataFrame | None = None
    is_synthetic: bool = False
    provenance: dict | None = None


def run(
    inputs: R001Inputs,
    *,
    config_path: str = "research/r001_margin.json",
    universe_config: str = "universe.jp.json",
    cost_config: str = "costs.jp.json",
    capital_jpy: float = 10_000_000,
    quick: bool = False,
) -> dict:
    """R001 を実行する。結果 dict を返し、実験ログに記録する。

    Parameters
    ----------
    quick:
        True で lookback とホライズンを絞る (開発中の動作確認用)。
        quick 実行の結果は実験ログに `n_tests_run` を正しく小さく記録する。
    """
    cfg = load_json(config_path)
    uni_cfg = load_json(universe_config)
    # 事前登録で指定されたコスト設定と、実際に読むファイルが一致することを確認する。
    # 一致しないまま走ると、結果に刻まれるコスト仮定が実際と食い違う。
    resolve_ref(cfg["cost_assumption"])
    cost_model = CostModel.from_json(CONFIG_DIR / cost_config)

    ctx = RunContext(
        experiment_id=cfg["experiment_id"],
        config_refs={
            "research": config_path,
            "universe": universe_config,
            "cost": cost_config,
        },
        notes=[
            "事前登録された設定でのみ実行している。設定を変えたら experiment_id を変える。",
        ],
    )

    # ---------------------------------------------------------- データ層 --
    quotes, _ = normalize.quotes_frame(inputs.bars)
    panel = build_price_panel(quotes)
    conv = ExecutionConvention()

    avail = cfg["availability"]
    margin_table: PITTable = normalize.margin_frame(
        inputs.margin_raw,
        calendar=panel.calendar,
        publication_lag_business_days=int(avail["publication_lag_business_days"]),
        publish_time_jst=str(avail["publication_time_jst"]),
        conservative_extra_lag_days=int(avail["conservative_extra_lag_days"]),
    )

    rules = UniverseRules.from_config(uni_cfg)
    listed = normalize.listed_frame(inputs.listed) if inputs.listed is not None else None
    uni = build_universe(panel, rules, listed=listed)

    # ------------------------------------------------------- 期間の分離 --
    research_end = pd.Timestamp(cfg["periods"]["research_end"])
    research_start = pd.Timestamp(cfg["periods"]["research_start"])
    dates = panel.dates

    # ユニバースが薄い日を最初から外す。20 銘柄未満のクロスセクションで
    # 分位や IC を計算しても、統計ではなく数銘柄の並び替えにしかならない。
    populated = pd.DatetimeIndex(uni.membership.index[uni.membership.sum(axis=1) >= 20])
    in_research = populated[(populated >= research_start) & (populated <= research_end)]

    if len(in_research) < 60:
        fallback = populated
        if len(fallback) < 60:
            raise ValueError(
                f"評価可能な日が {len(fallback)} 日しか無い "
                f"(ユニバース20銘柄以上の日)。\n"
                f"  価格データ期間 : {dates.min().date()} 〜 {dates.max().date()}\n"
                f"  ユニバース診断 : {uni.diagnostics}\n"
                "データ期間が足りないか、流動性フィルタが厳しすぎる。"
                "この状態で出した数字は解釈できないので実行を止める。"
            )
        ctx.notes.append(
            f"事前登録の研究期間 ({research_start.date()}〜{research_end.date()}) に"
            f"評価可能な日が {len(in_research)} 日しか無いため、利用可能な全期間 "
            f"({fallback.min().date()}〜{fallback.max().date()}) を使用した。"
            "**完全 OOS の分離が成立していない**ので、この実行の結果を採用判断に使ってはいけない。"
        )
        in_research = fallback

    decision_at = panel.calendar.decision_timestamps(in_research, conv)
    codes = list(panel.codes)

    # ------------------------------------------------------- PIT パネル --
    mpanel = margin_panel(margin_table, decision_at, codes)
    assert_available_at_respected(mpanel, decision_at)

    constant_cols = scan_panel_for_constant_future(mpanel, ["margin_long", "margin_short"])
    if constant_cols:
        ctx.notes.append(
            f"警告: {constant_cols} が銘柄ごとにほぼ定数。最新値を全期間に"
            "broadcast している可能性がある (重大なリーケージ)。"
        )

    # --------------------------------------------------------- シグナル --
    lookbacks = [20] if quick else list(cfg["signals"]["lookbacks_days"])
    horizons = [20] if quick else list(cfg["targets"]["horizons_days"])

    adv = panel.adv(20)
    mcap = (
        panel.close * inputs.shares_outstanding.reindex_like(panel.close)
        if inputs.shares_outstanding is not None
        else None
    )
    signals = build_r001_signals(mpanel, adv=adv, market_cap=mcap, lookbacks=lookbacks)
    signals = {k: uni.masked(v.reindex(index=in_research, columns=codes)) for k, v in signals.items()}

    # ----------------------------------------------------------- ラベル --
    targets = build_targets(
        panel, conv, horizons, sectors=inputs.sectors,
        variants=tuple(cfg["targets"]["variants"]),
    )
    targets = {k: v.reindex(index=in_research, columns=codes) for k, v in targets.items()}

    # ------------------------------------------------------------- IC --
    size_proxy = np.log(adv.where(adv > 0))
    beta = None  # ベンチマーク系列が無い構成では β 中立化を行わない

    neutralizations = ["none"] if quick else list(cfg["evaluation"]["neutralization"])
    ic_rows: list[dict] = []
    n_tests = 0

    for sig_name, sig in signals.items():
        for neut in neutralizations:
            if neut == "sector+size+beta" and beta is None:
                continue
            s = _neutralize_frame(sig, neut, inputs.sectors, size_proxy, beta)
            for tgt_name, tgt in targets.items():
                n_tests += 1
                ic = cross_sectional_ic(s, tgt, method="spearman")
                horizon = int(tgt_name.split("_")[0].replace("fwd", ""))
                summary = ic_summary(ic, overlap=horizon)
                ic_rows.append({
                    "signal": sig_name, "neutralization": neut, "target": tgt_name,
                    **{k: v for k, v in summary.items() if not k.startswith("_")},
                })

    ic_table = pd.DataFrame(ic_rows)

    # ------------------------------------------------- 分位ポートフォリオ --
    # 主系列は**事前に**決める。IC 表を見てから一番良いものを主系列にすると、
    # その時点で「1008 通りから選んだ 1 本」になり、多重検定の割り引きが
    # 効かないまま「主要な結果」を名乗ることになる。
    primary_horizon = horizons[len(horizons) // 2]
    primary_signal = f"margin_long_chg_{lookbacks[len(lookbacks) // 2]}d"
    primary_target = f"fwd{primary_horizon}_market_excess"
    if primary_signal not in signals or primary_target not in targets:
        primary_signal = sorted(signals)[0]
        primary_target = sorted(targets)[0]
        primary_horizon = int(primary_target.split("_")[0].replace("fwd", ""))

    qr = quantile_returns(signals[primary_signal], targets[primary_target], quantiles=5)
    qsum = quantile_summary(qr, quantiles=5, periods_per_year=max(1, int(252 / primary_horizon)))
    mono = monotonicity(qsum, quantiles=5)

    # ------------------------------------------------------ バックテスト --
    bt_config = BacktestConfig(
        rebalance_days=primary_horizon,
        capital_jpy=capital_jpy,
        conv=conv,
        constraints=PortfolioConstraints(),
    )
    weight_fn: Callable = lambda row, **kw: quantile_weights(row, quantiles=5, **kw)  # noqa: E731

    backtests: dict[str, dict] = {}
    strategy_returns: dict[str, pd.Series] = {}

    try:
        res = run_backtest(
            signals[primary_signal], panel, cost_model, bt_config,
            weight_fn=weight_fn, sectors=inputs.sectors, label=primary_signal,
        )
        backtests[primary_signal] = res.to_dict()
        strategy_returns[primary_signal] = res.returns
    except ValueError as e:
        backtests[primary_signal] = {"error": str(e)}
        res = None

    # ベースライン (README 20/40)。乱数に負けるなら発見ではない。
    for name, builder in {
        "baseline_momentum": lambda: baselines.momentum_scores(panel),
        "baseline_reversal": lambda: baselines.reversal_scores(panel),
        "baseline_lowvol": lambda: baselines.low_vol_scores(panel),
        "baseline_random": lambda: baselines.random_scores(panel, seed=ctx.seed),
    }.items():
        try:
            s = uni.masked(builder().reindex(index=in_research, columns=codes))
            b = run_backtest(s, panel, cost_model, bt_config,
                             weight_fn=weight_fn, sectors=inputs.sectors, label=name)
            backtests[name] = b.to_dict()
            strategy_returns[name] = b.returns
            n_tests += 1
        except ValueError as e:
            backtests[name] = {"error": str(e)}

    # ------------------------------------------------------ ストレステスト --
    stress: dict = {}
    if res is not None and not quick:
        stress["cost"] = cost_stress(
            signals[primary_signal], panel, cost_model, bt_config,
            weight_fn=weight_fn, sectors=inputs.sectors,
        ).to_dict("records")
        stress["signal_delay"] = delay_stress(
            signals[primary_signal], panel, cost_model, bt_config,
            weight_fn=weight_fn, sectors=inputs.sectors,
        ).to_dict("records")
        stress["capacity"] = capacity_curve(
            signals[primary_signal], panel, cost_model, bt_config,
            weight_fn=weight_fn, sectors=inputs.sectors,
            capitals=[1e6, 1e7, 1e8, 1e9],
        ).to_dict("records")

    # --------------------------------------------------------- 多重検定 --
    planned = int(cfg["multiple_testing"]["planned_tests"])
    logged = experiment_log.count_trials("R001")
    n_trials = max(planned, n_tests, logged)

    dsr = (
        deflated_sharpe_ratio(res.returns, n_trials=n_trials)
        if res is not None else {"dsr": None, "note": "バックテストが成立しなかった"}
    )

    # ----------------------------------------------------------- 結論 --
    verdict, conclusion = _conclude(
        ic_table, dsr, mono, backtests, primary_signal,
        is_synthetic=inputs.is_synthetic,
    )

    result = experiment_log.ExperimentResult(
        experiment_id=cfg["experiment_id"],
        title=cfg["title"],
        status="SUCCESS" if res is not None else "INCONCLUSIVE",
        hypothesis=cfg["hypothesis"]["statement"],
        conclusion=conclusion,
        evidence_level=verdict,
        data_is_synthetic=inputs.is_synthetic,
        dataset_version=str((inputs.provenance or {}).get("dataset_version", "unknown")),
        feature_version="1.0.0",
        model_version="quantile_long_short_v1",
        training_period=f"{in_research.min().date()} 〜 {in_research.max().date()}",
        test_period="未実施 (完全OOSは別コマンド)",
        parameters={
            "primary_signal": primary_signal,
            "primary_target": primary_target,
            "lookbacks": lookbacks,
            "horizons": horizons,
            "neutralizations": neutralizations,
            "quick": quick,
        },
        transaction_costs=cost_model.describe(),
        metrics={
            "ic_top10": ic_table.sort_values("mean_ic", key=abs, ascending=False)
                .head(10).to_dict("records") if not ic_table.empty else [],
            "quantile_summary": qsum.reset_index().to_dict("records"),
            "monotonicity": mono,
            "backtests": backtests,
            "stress": stress,
            "deflated_sharpe": dsr,
            "universe": uni.diagnostics,
            "margin_coverage": margin_table.coverage(),
            "pit_availability_rule": margin_table._meta.get("availability_rule"),
        },
        n_tests_run=n_tests,
        run_context=ctx.to_dict(),
    )
    path = experiment_log.save(result)

    return {
        "result": result.to_dict(),
        "result_path": str(path),
        "ic_table": ic_table,
        "quantile_summary": qsum,
        "strategy_returns": strategy_returns,
    }


def _neutralize_frame(
    sig: pd.DataFrame,
    mode: str,
    sectors: pd.Series,
    size: pd.DataFrame,
    beta: pd.DataFrame | None,
) -> pd.DataFrame:
    if mode == "none":
        return sig
    out = {}
    for d, row in sig.iterrows():
        out[d] = neutralize(
            row,
            sectors=sectors if "sector" in mode else None,
            size=size.loc[d] if "size" in mode and d in size.index else None,
            beta=beta.loc[d] if beta is not None and "beta" in mode and d in beta.index else None,
        )
    return pd.DataFrame(out).T.reindex(sig.index)


def _conclude(
    ic_table: pd.DataFrame,
    dsr: dict,
    mono: dict,
    backtests: dict,
    primary: str,
    *,
    is_synthetic: bool,
) -> tuple[str, str]:
    """証拠の強さを機械的に決める。

    「勝てる」と書けないように、語彙は EVIDENCE_LEVELS に限定されている。
    条件を満たさなければ自動的に下のレベルに落ちる。
    """
    if is_synthetic:
        return "insufficient evidence", (
            "合成データによる配管テスト。IC・分位・バックテストの各段が"
            "エラーなく通ることのみを確認した。市場に関する主張は一切含まない。"
        )

    if ic_table.empty:
        return "insufficient evidence", "IC が 1 本も計算できなかった。データ不足。"

    best = ic_table.reindex(ic_table["mean_ic"].abs().sort_values(ascending=False).index).iloc[0]
    t_nw = best.get("t_stat_newey_west")
    dsr_val = dsr.get("dsr")

    strat = backtests.get(primary, {}).get("stats", {})
    rand = backtests.get("baseline_random", {}).get("stats", {})
    beats_random = (
        strat.get("sharpe") is not None
        and rand.get("sharpe") is not None
        and strat["sharpe"] > rand["sharpe"] + 0.3
    )

    parts = [
        f"最良IC: {best['signal']} / {best['target']} / 中立化={best['neutralization']} "
        f"で mean_ic={best['mean_ic']:.4f}, ICIR={best.get('icir')}, "
        f"t(Newey-West)={t_nw if t_nw is None else round(t_nw, 2)}。",
        f"単調性(Spearman)={mono.get('monotonicity_spearman')}。",
        f"DSR={dsr_val if dsr_val is None else round(dsr_val, 3)} "
        f"(試行回数 {dsr.get('n_trials')} で割り引き)。",
        f"乱数ベースラインに対する優位: {'あり' if beats_random else 'なし'}。",
    ]

    if dsr_val is not None and dsr_val >= 0.95 and beats_random and abs(mono.get("monotonicity_spearman") or 0) > 0.7:
        level = "robust evidence"
    elif dsr_val is not None and dsr_val >= 0.90 and beats_random:
        level = "predictive evidence"
    elif t_nw is not None and abs(t_nw) > 2.0:
        level = "weak evidence"
    elif dsr_val is not None and dsr_val < 0.5:
        level = "likely overfit"
    else:
        level = "inconclusive"

    parts.append(
        "結果が良く見えても、完全OOSと Paper Trading を通るまでは採用しない。"
    )
    return level, " ".join(parts)
