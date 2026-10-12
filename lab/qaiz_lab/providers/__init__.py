"""データプロバイダ層。

    base       … 共通契約 / キャッシュ / レートリミット / リトライ
    normalize  … 生データ → 正規化モデル (列を推測せず検証する)
    jquants    … J-Quants API (Free プラン想定。可否は probe() の実測で決める)
    qaiz_pit   … QAIZ Worker の PIT ジャーナル (この統合の核心)
    stooq      … Stooq の無料日次CSV (配当調整なし)
    synthetic  … 合成データ (テスト・配管検証専用。研究データではない)

上位レイヤはこの層より下を知らない。プロバイダを差し替えても
特徴量とバックテストは変わらない。
"""

from .base import Cache, CapabilityReport, Provider, RateLimiter, retry_with_backoff
from .normalize import SchemaError, listed_frame, margin_frame, quotes_frame
from .qaiz_pit import QaizPitProvider
from .synthetic import SyntheticConfig, make_market

__all__ = [
    "Cache", "CapabilityReport", "Provider", "RateLimiter", "retry_with_backoff",
    "quotes_frame", "margin_frame", "listed_frame", "SchemaError",
    "QaizPitProvider", "make_market", "SyntheticConfig",
]
