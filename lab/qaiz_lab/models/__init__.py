"""モデル層。ベースラインから始める (README 20/44)。

Deep Learning は最後。データ量・特徴量・検証期間が十分でない状態で
Transformer を持ち込んでも、検証できない複雑さが増えるだけになる。
"""

from .baselines import (
    CrossSectionalRidge,
    cross_sectional_zscore,
    equal_weight_scores,
    low_vol_scores,
    momentum_scores,
    random_scores,
    require_sklearn,
    reversal_scores,
)

__all__ = [
    "equal_weight_scores", "random_scores", "momentum_scores", "reversal_scores",
    "low_vol_scores", "cross_sectional_zscore", "CrossSectionalRidge", "require_sklearn",
]
