"""設定の読み込みと乱数シードの管理。

ハードコードを避けるための入口。`configs/*.json` を読み、
研究の再現に必要な情報 (シード・設定ID・コードのバージョン) を 1 か所に集める。
"""

from __future__ import annotations

import json
import os
import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

#: リポジトリのルート (lab/qaiz_lab/config.py から 2 つ上)
REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = REPO_ROOT / "configs"
DATA_DIR = REPO_ROOT / "data"


def load_json(path: str | Path) -> dict:
    p = Path(path)
    if not p.is_absolute():
        p = CONFIG_DIR / p if (CONFIG_DIR / p).exists() else REPO_ROOT / p
    if not p.exists():
        raise FileNotFoundError(f"設定ファイルが無い: {p}")
    return json.loads(p.read_text(encoding="utf-8"))


def resolve_ref(ref: str) -> dict:
    """`configs/costs.jp.json#jp_retail_default` 形式の参照を解決する。"""
    path, _, expect_id = ref.partition("#")
    cfg = load_json(path)
    if expect_id and cfg.get("id") != expect_id:
        raise ValueError(
            f"参照 {ref} の id が一致しない: 期待={expect_id} 実際={cfg.get('id')}。"
            "設定を差し替えたまま実験ログの参照を直し忘れている可能性が高い。"
        )
    return cfg


def set_seeds(seed: int) -> None:
    """再現性のための乱数固定 (README 51)。

    Python 標準・numpy・PYTHONHASHSEED を揃える。ハッシュシードは
    プロセス起動時にしか効かないので、既に起動している場合は警告的に
    環境変数だけ設定する (次回起動から効く)。
    """
    random.seed(seed)
    np.random.seed(seed)
    os.environ.setdefault("PYTHONHASHSEED", str(seed))


def git_revision() -> str:
    """再現に必要なコードのバージョン。取れなければ 'unknown'。"""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=5, check=False,
        )
        rev = out.stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=REPO_ROOT, capture_output=True, text=True, timeout=5, check=False,
        ).stdout.strip()
        return f"{rev}{'-dirty' if dirty else ''}" if rev else "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


@dataclass
class RunContext:
    """1 回の研究実行を再現するのに必要な情報一式。

    結果 JSON に必ず埋め込む。これが無い結果は「再現できる」と言えない。
    """

    experiment_id: str
    seed: int = 20260910
    config_refs: dict[str, str] = field(default_factory=dict)
    git_revision: str = field(default_factory=git_revision)
    notes: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        set_seeds(self.seed)

    def to_dict(self) -> dict:
        import platform
        import sys

        return {
            "experiment_id": self.experiment_id,
            "seed": self.seed,
            "config_refs": self.config_refs,
            "git_revision": self.git_revision,
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "numpy": np.__version__,
            "notes": self.notes,
        }
