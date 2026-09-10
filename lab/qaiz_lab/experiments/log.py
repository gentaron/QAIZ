"""実験ログ。

## 失敗した研究を消さない

失敗を消すと、半年後に同じ仮説を思いついて同じ検証をやり直す。
そのとき偶然良い結果が出れば採用してしまう — これは**同じ仮説を
2 回試して良かったほうを採る**という、最も分かりやすい過適合である。

失敗は `status: FAILED` として理由つきで残す。残っていれば、
「これは前に試して駄目だった」で 1 週間が節約でき、
多重検定の試行回数カウンタも正しく積み上がる。

## 試行回数を数える

`EXPERIMENT_LOG.md` に積まれた実験の総数が、Deflated Sharpe Ratio に
渡すべき試行回数の下限になる。`count_trials()` がそれを数える。
自己申告に頼らないための仕組み。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from ..config import REPO_ROOT

LOG_PATH = REPO_ROOT / "EXPERIMENT_LOG.md"
RESULT_DIR = REPO_ROOT / "research" / "experiments"

Status = Literal["RUNNING", "SUCCESS", "FAILED", "INCONCLUSIVE", "BLOCKED"]

#: 結果の強さの語彙 (README 79)。これ以外の表現を使わない。
EVIDENCE_LEVELS = (
    "robust evidence",
    "predictive evidence",
    "weak evidence",
    "inconclusive",
    "insufficient evidence",
    "likely overfit",
    "no evidence",
)


@dataclass
class ExperimentResult:
    experiment_id: str
    title: str
    status: Status
    hypothesis: str
    conclusion: str
    evidence_level: str
    #: 合成データによる配管テストか。True なら市場に関する主張を一切しない
    data_is_synthetic: bool = False
    dataset_version: str = "unknown"
    feature_version: str = "unknown"
    model_version: str = "unknown"
    training_period: str | None = None
    validation_period: str | None = None
    test_period: str | None = None
    parameters: dict = field(default_factory=dict)
    transaction_costs: dict = field(default_factory=dict)
    metrics: dict = field(default_factory=dict)
    failure_reason: str | None = None
    n_tests_run: int = 1
    run_context: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    artifacts: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.evidence_level not in EVIDENCE_LEVELS:
            raise ValueError(
                f"evidence_level は {EVIDENCE_LEVELS} のいずれか: {self.evidence_level!r}。"
                "「勝てる」「有望」のような表現は使わない (README 41/79)。"
            )
        if self.data_is_synthetic and "合成データ" not in self.conclusion:
            self.conclusion = (
                "【合成データによる配管テスト — 市場に関する主張を含まない】 " + self.conclusion
            )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def save(result: ExperimentResult) -> Path:
    """結果 JSON を保存し、EXPERIMENT_LOG.md に 1 行追記する。"""
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = result.created_at.replace(":", "").replace("-", "")[:15]
    path = RESULT_DIR / f"{result.experiment_id}_{stamp}.json"
    path.write_text(
        json.dumps(result.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _append_log(result, path)
    return path


def _append_log(result: ExperimentResult, path: Path) -> None:
    if not LOG_PATH.exists():
        LOG_PATH.write_text(_header(), encoding="utf-8")

    text = LOG_PATH.read_text(encoding="utf-8")
    marker = "<!-- APPEND BELOW -->"
    try:
        link = path.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        # テストなどで結果をリポジトリ外に書いた場合。リンクは絶対パスにする
        link = path.as_posix()
    row = (
        f"| {result.created_at[:10]} | `{result.experiment_id}` | {result.status} | "
        f"{result.evidence_level} | {'合成' if result.data_is_synthetic else '実データ'} | "
        f"{result.n_tests_run} | {result.conclusion[:70].replace('|', '/')} | "
        f"[{path.name}]({link}) |"
    )
    text = text.replace(marker, marker + "\n" + row) if marker in text else text.rstrip() + "\n" + row + "\n"
    LOG_PATH.write_text(text, encoding="utf-8")


def _header() -> str:
    return """# EXPERIMENT_LOG

すべての研究の記録。**失敗した研究も消さない** (README 48)。
消すと同じ仮説を再検証して「今度は良かった」を採ってしまう。

`n_tests` 列の合計が、Deflated Sharpe Ratio に渡すべき試行回数の下限になる。

| 日付 | ID | 状態 | 証拠の強さ | データ | n_tests | 結論 | 詳細 |
|---|---|---|---|---|---|---|---|
<!-- APPEND BELOW -->
"""


def count_trials(experiment_prefix: str | None = None) -> int:
    """記録済み実験の試行回数を合計する。

    DSR の `n_trials` にはこの値以上を渡す。少なく申告すると、
    その割り引きは意味を失う。
    """
    if not RESULT_DIR.exists():
        return 0
    total = 0
    for p in RESULT_DIR.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if experiment_prefix and not str(data.get("experiment_id", "")).startswith(experiment_prefix):
            continue
        total += int(data.get("n_tests_run", 1))
    return total


def load_all() -> list[dict]:
    if not RESULT_DIR.exists():
        return []
    out = []
    for p in sorted(RESULT_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return out
