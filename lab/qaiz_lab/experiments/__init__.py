"""研究実験。

    log         … 実験ログ (失敗も残す / 試行回数を数える)
    r001_margin … Research 001: 信用取引残高変化の予測力
"""

from . import log, r001_margin
from .log import EVIDENCE_LEVELS, ExperimentResult, count_trials, save

__all__ = ["log", "r001_margin", "ExperimentResult", "save", "count_trials", "EVIDENCE_LEVELS"]
