"""TypeScript との計算一致 (パリティ) 検証。

`configs/parity_vectors.json` は **TypeScript 側 (src/analytics/stats.ts) が
生成した値**であり、これが「正」。Python 側がこれに一致しなければ落ちる。

このテストが守っているもの:

    ダッシュボードが「バリュー 72 点」と表示している銘柄について、
    研究ラボも 72 点と計算する。

一致していなければ、ダッシュボードの示す相対順位と、研究で検証した
シグナルが別物になる。バックテストで検証したのと違うものを画面で見て
売買することになるので、これは単なる整合性ではなく安全装置である。

TS 側を変更したら `npm run export:shared` で再生成し、Python 側も
追随させること。追随しなければここで落ちる。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from qaiz_lab.config import CONFIG_DIR
from qaiz_lab.xsection import (
    mad,
    median,
    percentile_ranks,
    quantile,
    weighted_mean,
    winsorize,
    z_to_score,
    zscores,
)

VECTORS_PATH: Path = CONFIG_DIR / "parity_vectors.json"


@pytest.fixture(scope="module")
def vectors() -> dict:
    if not VECTORS_PATH.exists():
        pytest.fail(
            f"{VECTORS_PATH} が無い。`npm run export:shared` で生成すること。"
        )
    return json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


def _close(a, b, tol: float) -> bool:
    """None 同士も一致とみなす。None と数値は不一致。"""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and math.isnan(a):
        return isinstance(b, float) and math.isnan(b)
    return abs(float(a) - float(b)) <= tol


def _assert_seq(actual, expected, tol: float, label: str, case_id: str) -> None:
    assert len(actual) == len(expected), (
        f"[{case_id}/{label}] 長さが違う: Python={len(actual)} TS={len(expected)}"
    )
    for i, (a, e) in enumerate(zip(actual, expected, strict=False)):
        assert _close(a, e, tol), (
            f"[{case_id}/{label}] 要素 {i} が一致しない: Python={a!r} TS={e!r}\n"
            "src/analytics/stats.ts と lab/qaiz_lab/xsection.py のどちらかが"
            "先に変更されている。両方を揃えること。"
        )


def test_vectors_file_is_generated(vectors: dict) -> None:
    """生成物であることが明記されているか (手編集の防止)。"""
    assert "npm run export:shared" in vectors["_generated_by"]
    assert vectors["source"] == "src/analytics/stats.ts"
    assert len(vectors["cases"]) >= 6, "検証ケースが少なすぎる"


def test_scalar_statistics_match(vectors: dict) -> None:
    tol = float(vectors["_tolerance"])
    for case in vectors["cases"]:
        finite = [v for v in case["input"] if v is not None]
        exp = case["expected"]
        cid = case["id"]
        assert _close(median(finite), exp["median"], tol), f"[{cid}] median"
        assert _close(mad(finite), exp["mad"], tol), f"[{cid}] mad"
        assert _close(quantile(finite, 0.25), exp["q25"], tol), f"[{cid}] q25"
        assert _close(quantile(finite, 0.75), exp["q75"], tol), f"[{cid}] q75"


def test_winsorize_matches(vectors: dict) -> None:
    tol = float(vectors["_tolerance"])
    for case in vectors["cases"]:
        finite = [v for v in case["input"] if v is not None]
        _assert_seq(winsorize(finite, 0.05), case["expected"]["winsorize_05"], tol,
                    "winsorize_05", case["id"])


def test_zscores_match(vectors: dict) -> None:
    """3 種類の Z スコア (素・ウィンザライズ・頑健) すべてで一致すること。"""
    tol = float(vectors["_tolerance"])
    for case in vectors["cases"]:
        xs = case["input"]
        exp = case["expected"]
        cid = case["id"]
        _assert_seq(zscores(xs), exp["zscores_plain"], tol, "zscores_plain", cid)
        _assert_seq(zscores(xs, winsorize_at=0.05), exp["zscores_winsorized"], tol,
                    "zscores_winsorized", cid)
        _assert_seq(zscores(xs, winsorize_at=0.05, robust=True), exp["zscores_robust"], tol,
                    "zscores_robust", cid)


def test_percentile_ranks_match(vectors: dict) -> None:
    tol = float(vectors["_tolerance"])
    for case in vectors["cases"]:
        _assert_seq(percentile_ranks(case["input"]), case["expected"]["percentile_ranks"],
                    tol, "percentile_ranks", case["id"])


def test_z_to_score_matches(vectors: dict) -> None:
    """0-100 スコアへの写像。JS の Math.round との丸め差が出やすい箇所。"""
    tol = float(vectors["_tolerance"])
    for case in vectors["cases"]:
        z = zscores(case["input"], winsorize_at=0.05)
        _assert_seq([z_to_score(v) for v in z], case["expected"]["z_to_score"],
                    tol, "z_to_score", case["id"])


def test_weighted_mean_matches(vectors: dict) -> None:
    tol = float(vectors["_tolerance"])
    block = vectors["weighted_mean"]
    items = [(it["value"], it["weight"]) for it in block["input"]]
    value, used = weighted_mean(items)
    assert _close(value, block["expected"]["value"], tol), "weighted_mean.value"
    assert _close(used, block["expected"]["usedWeight"], tol), "weighted_mean.usedWeight"


def test_missing_values_are_not_filled_with_zero(vectors: dict) -> None:
    """欠損が 0 に潰れていないこと。

    このプロジェクトで最も重大な設計上の約束。0 で埋めると
    「データが無い銘柄」が「ピア平均の銘柄」としてランキング中央に並ぶ。
    """
    case = next(c for c in vectors["cases"] if c["id"] == "with_nulls")
    z = zscores(case["input"], winsorize_at=0.05)
    for i, v in enumerate(case["input"]):
        if v is None:
            assert z[i] is None, f"欠損 (index {i}) が None のまま残っていない: {z[i]!r}"


def test_insufficient_sample_returns_none(vectors: dict) -> None:
    """有効値 3 未満なら Z スコアは出さない。

    2 銘柄の Z は常に ±0.707 で、情報量ゼロなのに数字だけが出る。
    """
    case = next(c for c in vectors["cases"] if c["id"] == "two_valid")
    assert all(v is None for v in zscores(case["input"])), (
        "有効値 2 個で Z スコアが返っている"
    )


def test_zero_dispersion_returns_none(vectors: dict) -> None:
    """散らばりゼロでゼロ除算しないこと。"""
    case = next(c for c in vectors["cases"] if c["id"] == "constant")
    assert all(v is None for v in zscores(case["input"]))
    assert all(v is None for v in zscores(case["input"], robust=True))
