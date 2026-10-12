"""qaiz_lab — 日本株 AI クオンツ研究ラボ。

QAIZ (Cloudflare Workers 上のライブ分析ダッシュボード) と対になる、
ローカル PC で動く研究側。役割分担は明確に分けてある:

    Worker (TypeScript)  … 現在の観測・可視化・**PIT ジャーナルの記録**
    Lab    (Python)      … 過去の検証・仮説の反証・バックテスト

両者は 3 つの接点で結ばれている:

  1. **PIT ジャーナル** — Worker が無料 cron で毎回見ている
     ファンダメンタルズ/コンセンサスを観測時刻つきで追記保存し、
     ラボが `/api/pit/export` から読む。後から買えない Point-in-Time
     データが、記録しているというだけで手に入る。
  2. **計算のパリティ** — Z スコア・ウィンザライズ・分位の定義を
     両言語で一致させ、`configs/parity_vectors.json` で相互検証する。
     ダッシュボードの「72点」と研究の「72点」が同じ意味になる。
  3. **共有 config** — ユニバース規則・コスト仮定を `configs/*.json` に
     1 つだけ置く。

設計原則は README / RESEARCH_PROTOCOL.md にある。要点は 1 つ:

    儲かるバックテストを作ることより、
    儲かるように見えるインチキバックテストを見破ることを優先する。
"""

__version__ = "0.1.0"

from . import (
    backtest,
    calendar,
    config,
    costs,
    features,
    labels,
    leakage,
    metrics,
    pit,
    portfolio,
    prices,
    universe,
    validation,
    xsection,
)

__all__ = [
    "backtest", "calendar", "config", "costs", "features", "labels", "leakage",
    "metrics", "pit", "portfolio", "prices", "universe", "validation", "xsection",
]
