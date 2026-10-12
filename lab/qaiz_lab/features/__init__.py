"""特徴量エンジン。

各特徴量は `registry.FeatureSpec` として定義と同じ場所にメタデータを持つ。
`REGISTRY.build_dictionary()` が DATA_DICTIONARY.md の表を生成する。
"""

from . import margin, price  # noqa: F401 — import 時に REGISTRY へ登録される
from .registry import REGISTRY, FeatureRegistry, FeatureSpec, correlation_clusters

__all__ = ["REGISTRY", "FeatureRegistry", "FeatureSpec", "correlation_clusters", "price", "margin"]
