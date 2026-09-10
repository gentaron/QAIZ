"""時系列の分割 — Walk-Forward と Purged CV。

金融時系列にランダムな train_test_split を当ててはいけない。理由は 2 つ。

1. **未来で学習して過去を予測する**ことになる。2024 年のデータで学習した
   モデルで 2015 年を予測しても、実運用では絶対に起きない状況を評価している。
2. **観測が重なっている**。ホライズン 20 日のラベルは 20 日ぶんの未来を含むので、
   訓練の最後の 20 日とテストの最初の 20 日は同じリターンを共有する。
   ランダム分割だとこれが全体に散らばり、実質的に答えを見ながら学習する。

対策:
    Purge   … テスト期間と重なるラベルを持つ訓練サンプルを削る
    Embargo … テスト期間の直後も一定期間だけ訓練から外す
              (系列相関でテスト直後のサンプルがテスト情報を含むため)

参考: Marcos López de Prado, *Advances in Financial Machine Learning*, Ch.7。
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class Split:
    """1 つの学習/検証の組。"""

    train: pd.DatetimeIndex
    test: pd.DatetimeIndex
    label: str

    def describe(self) -> dict:
        return {
            "label": self.label,
            "train_from": str(self.train.min().date()) if len(self.train) else None,
            "train_to": str(self.train.max().date()) if len(self.train) else None,
            "train_n": int(len(self.train)),
            "test_from": str(self.test.min().date()) if len(self.test) else None,
            "test_to": str(self.test.max().date()) if len(self.test) else None,
            "test_n": int(len(self.test)),
        }


def walk_forward(
    dates: pd.DatetimeIndex,
    *,
    train_years: int = 5,
    test_years: int = 1,
    expanding: bool = True,
    label_horizon_days: int = 20,
    embargo_days: int = 5,
) -> list[Split]:
    """未来に向かって順次モデルを更新する分割。

        Train 2010-2015 → Test 2016
        Train 2010-2016 → Test 2017
        ...

    `expanding=False` にすると窓を固定長でずらすローリング方式になる。
    どちらが正しいかは仮説による: 市場構造が安定していると考えるなら拡張、
    レジームが変わると考えるなら固定長。両方回して結果が違うなら、
    それ自体が「この戦略はレジーム依存」という発見。

    訓練の末尾からは `label_horizon_days + embargo_days` を必ず削る (purge)。
    """
    idx = pd.DatetimeIndex(dates).sort_values()
    if len(idx) == 0:
        return []
    start, end = idx.min(), idx.max()
    splits: list[Split] = []

    train_end = start + pd.DateOffset(years=train_years)
    while True:
        test_start = train_end
        test_end = test_start + pd.DateOffset(years=test_years)
        if test_start >= end:
            break

        train_start = start if expanding else train_end - pd.DateOffset(years=train_years)
        # purge + embargo: テスト開始より前でも、ラベルがテスト期間に食い込む
        # 訓練サンプルは使えない
        purge_cut = test_start - pd.Timedelta(days=int(label_horizon_days * 1.5) + embargo_days)

        train = idx[(idx >= train_start) & (idx < purge_cut)]
        test = idx[(idx >= test_start) & (idx < min(test_end, end + pd.Timedelta(days=1)))]
        if len(train) > 0 and len(test) > 0:
            splits.append(Split(train, test, f"train→{purge_cut.date()} / test {test_start.date()}"))

        train_end = test_end
        if train_end >= end:
            break
    return splits


def purged_kfold(
    dates: pd.DatetimeIndex,
    *,
    n_splits: int = 5,
    label_horizon_days: int = 20,
    embargo_days: int = 5,
) -> list[Split]:
    """Purged K-Fold CV (embargo つき)。

    連続したブロックで分割し、各テストブロックの前後から
    ラベル重なり + embargo ぶんを訓練から取り除く。

    Walk-Forward と違って未来で学習する fold が含まれるので、
    **実運用の期待値としては使えない**。使ってよいのはハイパーパラメータの
    比較のような相対評価だけ。最終判断は必ず Walk-Forward と
    完全 OOS で行う。
    """
    idx = pd.DatetimeIndex(dates).sort_values()
    n = len(idx)
    if n < n_splits * 3:
        return []

    bounds = [int(round(i * n / n_splits)) for i in range(n_splits + 1)]
    gap = pd.Timedelta(days=int(label_horizon_days * 1.5) + embargo_days)
    splits = []
    for k in range(n_splits):
        lo, hi = bounds[k], bounds[k + 1]
        test = idx[lo:hi]
        if len(test) == 0:
            continue
        keep = (idx < test.min() - gap) | (idx > test.max() + gap)
        train = idx[keep]
        if len(train) > 0:
            splits.append(Split(train, test, f"fold{k + 1}/{n_splits}"))
    return splits


def iter_split_frames(
    frames: dict[str, pd.DataFrame], splits: list[Split]
) -> Iterator[tuple[Split, dict[str, pd.DataFrame], dict[str, pd.DataFrame]]]:
    """分割を DataFrame 群に適用して回すヘルパ。"""
    for sp in splits:
        tr = {k: v.reindex(v.index.intersection(sp.train)) for k, v in frames.items()}
        te = {k: v.reindex(v.index.intersection(sp.test)) for k, v in frames.items()}
        yield sp, tr, te
