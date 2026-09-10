"""特徴量レジストリ。

README 16 が要求する 7 項目 (feature_name / definition / source / lookback /
calculation / availability / version) を、**コードと同じ場所に**持たせる。

別ファイルの表として管理すると必ずコードとずれる。ずれた表は無いより悪い
(「availability: T+1」と書いてあるのに実装は T で使っている、が起きる)。
`build_dictionary()` が DATA_DICTIONARY.md の該当セクションを生成するので、
表はコードから作る。手で書かない。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import pandas as pd

Category = Literal[
    "price", "momentum", "volume", "liquidity", "volatility", "value", "quality",
    "growth", "earnings", "margin", "short_interest", "investor_flow",
    "market_regime", "sector", "corporate_action",
]


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    category: Category
    definition: str
    source: str
    #: 計算に必要な過去日数。None = 断面のみ
    lookback: int | None
    calculation: str
    #: シグナル日から見ていつ使えるか。PIT の根拠を書く
    availability: str
    version: str = "1.0.0"
    #: 高相関になりやすい既知の兄弟特徴量
    correlated_with: tuple[str, ...] = ()
    notes: str = ""

    def to_row(self) -> dict:
        return {
            "feature_name": self.name,
            "category": self.category,
            "definition": self.definition,
            "source": self.source,
            "lookback": self.lookback,
            "calculation": self.calculation,
            "availability": self.availability,
            "version": self.version,
            "correlated_with": ", ".join(self.correlated_with),
            "notes": self.notes,
        }


class FeatureRegistry:
    def __init__(self) -> None:
        self._specs: dict[str, FeatureSpec] = {}
        self._builders: dict[str, Callable] = {}

    def register(self, spec: FeatureSpec, builder: Callable | None = None) -> FeatureSpec:
        if spec.name in self._specs and self._specs[spec.name] != spec:
            raise ValueError(
                f"特徴量 {spec.name} が異なる定義で二重登録された。"
                "同じ名前で違う計算をすると、実験ログの再現性が壊れる。"
            )
        self._specs[spec.name] = spec
        if builder is not None:
            self._builders[spec.name] = builder
        return spec

    def get(self, name: str) -> FeatureSpec:
        if name not in self._specs:
            raise KeyError(f"未登録の特徴量: {name}. 登録済み: {sorted(self._specs)}")
        return self._specs[name]

    def names(self) -> list[str]:
        return sorted(self._specs)

    def to_frame(self) -> pd.DataFrame:
        rows = [s.to_row() for s in self._specs.values()]
        return pd.DataFrame(rows).sort_values(["category", "feature_name"]).reset_index(drop=True)

    def build_dictionary(self) -> str:
        """DATA_DICTIONARY.md に貼る Markdown 表を生成する。"""
        df = self.to_frame()
        if df.empty:
            return "_登録された特徴量はまだ無い。_\n"
        lines = ["| 特徴量 | 分類 | 定義 | 出所 | lookback | 利用可能時点 | ver |",
                 "|---|---|---|---|---|---|---|"]
        for _, r in df.iterrows():
            lines.append(
                f"| `{r.feature_name}` | {r.category} | {r.definition} | {r.source} | "
                f"{'—' if pd.isna(r.lookback) else int(r.lookback)} | {r.availability} | {r.version} |"
            )
        return "\n".join(lines) + "\n"


REGISTRY = FeatureRegistry()


def correlation_clusters(
    features: dict[str, pd.DataFrame], threshold: float = 0.9
) -> list[list[str]]:
    """相関の高い特徴量をまとめる (README 17)。

    PER と益利回りのように、実質同じ情報を持つ特徴量を大量に作ると、
    モデルの重要度が分散して「どれも効いていない」ように見える。
    しかもクロスセクション回帰では多重共線性で係数が不安定になる。

    やり方は単純で、平均クロスセクション相関 > threshold のペアを
    連結成分としてまとめるだけ。階層クラスタリングを持ち込むほどの
    精度は要らない (目的は「気付くこと」であって最適な分割ではない)。
    """
    names = sorted(features)
    if len(names) < 2:
        return [[n] for n in names]

    corr: dict[tuple[str, str], float] = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            fa, fb = features[a], features[b]
            dates = fa.index.intersection(fb.index)
            codes = fa.columns.intersection(fb.columns)
            if len(dates) == 0 or len(codes) < 5:
                continue
            vals = []
            for d in dates[:: max(1, len(dates) // 60)]:  # 最大 60 断面で十分
                x = pd.to_numeric(fa.loc[d, codes], errors="coerce")
                y = pd.to_numeric(fb.loc[d, codes], errors="coerce")
                m = x.notna() & y.notna()
                if m.sum() >= 5:
                    # 順位に直してから Pearson を取る = Spearman。
                    # pandas の method="spearman" は scipy を要求するので使わない
                    # (この 1 行のために必須依存を増やすのは割に合わない)。
                    rx, ry = x[m].rank(), y[m].rank()
                    if rx.std() > 1e-12 and ry.std() > 1e-12:
                        vals.append(rx.corr(ry))
            if vals:
                corr[(a, b)] = float(pd.Series(vals).mean())

    parent = {n: n for n in names}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for (a, b), c in corr.items():
        if abs(c) >= threshold:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

    groups: dict[str, list[str]] = {}
    for n in names:
        groups.setdefault(find(n), []).append(n)
    return sorted((sorted(v) for v in groups.values()), key=lambda g: g[0])
