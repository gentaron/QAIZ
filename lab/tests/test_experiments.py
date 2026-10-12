"""実験ログと R001 のエンドツーエンド検証。

E2E テストの目的は「良い数字が出ること」ではない。
**配管が繋がっていて、しかも嘘をつかないこと**の確認である。

  - 埋め込んだ信号を検出できるか (検出できないパイプラインは、実データで
    何も出なかったときに「効果が無い」のか「壊れている」のか区別できない)
  - 合成データの結果に必ず但し書きが付くか
  - 「勝てる」のような語彙が結果に混入しないか
"""

from __future__ import annotations

import pytest

from qaiz_lab.experiments import log as experiment_log
from qaiz_lab.experiments import r001_margin
from qaiz_lab.providers.synthetic import SyntheticConfig, make_market


@pytest.fixture(autouse=True)
def isolated_log(tmp_path, monkeypatch):
    """実験ログをテンポラリに逃がす (リポジトリを汚さない)。"""
    monkeypatch.setattr(experiment_log, "RESULT_DIR", tmp_path / "experiments")
    monkeypatch.setattr(experiment_log, "LOG_PATH", tmp_path / "EXPERIMENT_LOG.md")
    return tmp_path


def _inputs(effect: float, *, n_codes=45, n_days=520):
    m = make_market(SyntheticConfig(n_codes=n_codes, n_days=n_days, margin_effect=effect))
    return r001_margin.R001Inputs(
        bars=m["bars"], margin_raw=m["margin_raw"], sectors=m["sectors"],
        listed=m["listed"], is_synthetic=True,
        provenance={"dataset_version": "synthetic:test"},
    )


# ------------------------------------------------------------ ログ --


def test_evidence_vocabulary_is_enforced() -> None:
    """「勝てる」のような表現を弾く。"""
    with pytest.raises(ValueError, match="evidence_level"):
        experiment_log.ExperimentResult(
            experiment_id="X", title="t", status="SUCCESS",
            hypothesis="h", conclusion="c", evidence_level="勝てる",
        )


def test_synthetic_results_are_labelled(isolated_log) -> None:
    """合成データの結論に但し書きが自動で付くこと。"""
    r = experiment_log.ExperimentResult(
        experiment_id="X", title="t", status="SUCCESS", hypothesis="h",
        conclusion="IC が高かった", evidence_level="inconclusive",
        data_is_synthetic=True,
    )
    assert "合成データ" in r.conclusion


def test_failed_experiments_are_kept(isolated_log) -> None:
    """失敗も記録されること (README 48)。"""
    experiment_log.save(experiment_log.ExperimentResult(
        experiment_id="X001", title="失敗した研究", status="FAILED",
        hypothesis="h", conclusion="リーケージが見つかったため中止",
        evidence_level="no evidence", failure_reason="available_at の取り違え",
        n_tests_run=12,
    ))
    entries = experiment_log.load_all()
    assert len(entries) == 1
    assert entries[0]["status"] == "FAILED"
    assert entries[0]["failure_reason"]
    assert experiment_log.LOG_PATH.exists()
    assert "FAILED" in experiment_log.LOG_PATH.read_text(encoding="utf-8")


def test_trial_count_accumulates(isolated_log) -> None:
    """試行回数が積み上がること (DSR に渡す n_trials の下限になる)。"""
    for i in range(3):
        experiment_log.save(experiment_log.ExperimentResult(
            experiment_id=f"R001{chr(97 + i)}", title="t", status="SUCCESS",
            hypothesis="h", conclusion="c", evidence_level="inconclusive",
            n_tests_run=10,
        ))
    assert experiment_log.count_trials("R001") == 30


# ------------------------------------------------------------- E2E --


def test_r001_runs_end_to_end_on_synthetic_data(isolated_log) -> None:
    out = r001_margin.run(_inputs(effect=0.0), quick=True)
    res = out["result"]

    assert res["status"] in ("SUCCESS", "INCONCLUSIVE")
    assert res["data_is_synthetic"] is True
    assert "合成データ" in res["conclusion"]
    assert res["evidence_level"] == "insufficient evidence", (
        "合成データの実行が『証拠あり』を主張している"
    )
    # 再現に必要な情報が揃っていること
    ctx = res["run_context"]
    assert ctx["seed"] and ctx["git_revision"] and ctx["config_refs"]
    assert res["transaction_costs"]["config_id"].startswith("costs.jp.json")


def test_r001_detects_embedded_signal(isolated_log) -> None:
    """埋め込んだ効果を IC が検出すること。

    検出できないなら、実データで何も出なかったときにその結果を
    「効果が無い」と読んではいけない (パイプラインが壊れている可能性)。
    """
    out = r001_margin.run(_inputs(effect=0.005), quick=True)
    ic = out["ic_table"]
    assert not ic.empty
    best = ic["mean_ic"].abs().max()
    assert best > 0.05, f"埋め込んだ信号を検出できていない (最良 |IC| = {best:.4f})"


def test_r001_finds_nothing_when_there_is_nothing(isolated_log) -> None:
    """効果ゼロの世界で IC がゼロ近傍になること。

    ここで大きな IC が出るなら、それはリーケージである。
    """
    out = r001_margin.run(_inputs(effect=0.0), quick=True)
    ic = out["ic_table"]
    assert not ic.empty
    best = ic["mean_ic"].abs().max()
    # 実測: 効果ゼロで max|IC| = 0.049 (t_NW = 1.20、有意でない)。
    # 0.10 は 2 倍の余裕を見た閾値。ここを超えるなら、PIT 結合か
    # ラベル生成のどちらかが未来を見ている。
    assert best < 0.10, (
        f"効果を埋め込んでいないのに |IC| = {best:.4f} が出ている。"
        "PIT 結合かラベル生成で未来情報が混入している疑いが強い。"
    )


def test_r001_reports_survivorship_and_pit_caveats(isolated_log) -> None:
    """制約が結果に明記されること。黙って進まないこと。"""
    out = r001_margin.run(_inputs(effect=0.0), quick=True)
    m = out["result"]["metrics"]
    assert m["universe"]["survivorship_bias"] == "PRESENT"
    assert "UNVERIFIED" in m["pit_availability_rule"]["verification"]
    assert m["margin_coverage"]["median_publication_lag_days"] > 0


def test_r001_stops_when_data_is_too_short(isolated_log) -> None:
    """データが足りなければ数字を出さずに止まること。"""
    with pytest.raises(ValueError, match="評価可能な日"):
        r001_margin.run(_inputs(effect=0.0, n_codes=40, n_days=270), quick=True)


def test_r001_refuses_margin_data_with_unknown_columns(isolated_log) -> None:
    """列名が想定と違えば、リネームで誤魔化さずに止まること。"""
    from qaiz_lab.providers.normalize import SchemaError

    inputs = _inputs(effect=0.0)
    inputs.margin_raw = inputs.margin_raw.rename(
        columns={"LongMarginTradeVolume": "ナゾの列名"}
    )
    with pytest.raises(SchemaError, match="信用買残"):
        r001_margin.run(inputs, quick=True)
