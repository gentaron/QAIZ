"""リーケージ検出。

「バックテストが良すぎる」ときの原因はたいてい 3 つのどれかで、
そのすべてが**自動で検出できる**。目視のコードレビューに頼らない。

1. **available_at 違反** — 判断時刻より後に入手した情報を使っている
2. **ラベルのずれ** — シグナル日の価格からリターンを測っている
3. **切り詰め不整合** — 特徴量が系列全体を見て計算されている
   (全期間の平均で標準化する、全期間の分位点でビン分けする、など)

3 が最も見つけにくい。`StandardScaler().fit_transform(全期間)` のような
1 行で入り込み、コードを読んでも「普通の標準化」にしか見えない。
`truncation_consistency` はこれを機械的に暴く: **過去だけを渡して計算し直し、
同じ値になるか**を確かめる。ならなければ、その特徴量は未来を見ている。
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pandas as pd


class LeakageError(AssertionError):
    """リーケージ検出。テストを失敗させ、研究を止めるための例外。"""


def assert_available_at_respected(panel: pd.DataFrame, decision_at: pd.Series) -> None:
    """PIT パネルの全観測が判断時刻以前に入手済みであることを検査する。

    `PITTable.asof_panel()` は構造上これを満たすが、その後に手で結合したり
    `shift()` したりすると簡単に壊れる。パイプラインの出口で毎回呼ぶ。
    """
    if "available_at" not in panel.columns:
        raise LeakageError("パネルに available_at 列が無い。PIT 準拠を検証できない。")

    used = panel[panel["available_at"].notna()]
    if used.empty:
        return

    dates = used.index.get_level_values("date")
    limit = pd.Series(dates, index=used.index).map(decision_at)
    if limit.isna().any():
        raise LeakageError(
            f"decision_at に無い日付が {int(limit.isna().sum())} 件パネルに含まれている。"
        )

    violation = used["available_at"].to_numpy() > pd.DatetimeIndex(limit).to_numpy()
    if violation.any():
        bad = used[violation].head(5)
        raise LeakageError(
            f"未来情報の混入: available_at が判断時刻より後の観測が "
            f"{int(violation.sum())} 件ある。\n{bad[['available_at']]}"
        )


def assert_no_future_observations(table_frame: pd.DataFrame, now: pd.Timestamp | None = None) -> None:
    """available_at が現在時刻より未来の行が無いことを検査する。

    タイムゾーンの取り違え (JST を UTC として読む) や、公表日の計算ミスで起きる。
    +9 時間ずれても日中は気付きにくいが、リーケージとしては致命的。
    """
    now = pd.Timestamp.now(tz="Asia/Tokyo") if now is None else now
    future = table_frame["available_at"] > now
    if future.any():
        raise LeakageError(
            f"available_at が現在時刻より未来の行が {int(future.sum())} 件ある。"
            "タイムゾーンの取り違えか公表日計算のバグ。"
        )


def assert_label_alignment(
    signal_dates: pd.DatetimeIndex,
    calendar,
    execution_lag_sessions: int,
) -> None:
    """ラベルの測定開始がシグナル日より後であることを検査する。"""
    if execution_lag_sessions < 1:
        raise LeakageError(
            f"execution_lag_sessions={execution_lag_sessions} は、シグナルを作った"
            "その時点の価格で約定できるという仮定を意味する。引けで判断して"
            "同じ引けで約定することは物理的にできない。1 以上にすること。"
        )
    for d in signal_dates[:5]:
        e = calendar.shift(d, execution_lag_sessions)
        if e is not None and e <= pd.Timestamp(d):
            raise LeakageError(f"約定日 {e} がシグナル日 {d} 以前になっている")


def truncation_consistency(
    build: Callable[[pd.DataFrame], pd.DataFrame],
    source: pd.DataFrame,
    test_dates: list,
    *,
    date_col: str = "date",
    atol: float = 1e-9,
) -> None:
    """特徴量が「その日までの情報」だけで決まっているかを検査する。

    やること:
        1. 全期間データで特徴量を計算する
        2. 日付 D 以前だけに切り詰めたデータで計算し直す
        3. D 行目が一致するか比べる

    一致しなければ、その特徴量は D より後の情報を使っている。
    典型例:
        - 全期間の平均・標準偏差で標準化している
        - 全期間の分位点でビン分けしている
        - `fillna(method="bfill")` で後ろから埋めている
        - `rolling(...).mean().shift(-1)` の符号ミス

    Parameters
    ----------
    build:
        入力 DataFrame から特徴量 DataFrame (index=date) を作る関数。
    source:
        `date_col` を持つ生データ。
    test_dates:
        検査する日付。系列の中ほどを 3〜5 点選ぶとよい (端は窓不足で NaN になる)。
    """
    full = build(source)
    if not isinstance(full.index, pd.DatetimeIndex):
        raise LeakageError("build() の戻り値は index が DatetimeIndex でなければならない")

    for d in test_dates:
        d = pd.Timestamp(d)
        truncated = source[pd.to_datetime(source[date_col]) <= d]
        partial = build(truncated)
        if d not in partial.index or d not in full.index:
            continue

        a = pd.to_numeric(full.loc[d], errors="coerce")
        b = pd.to_numeric(partial.loc[d], errors="coerce").reindex(a.index)

        both_nan = a.isna() & b.isna()
        diff = (~both_nan) & (~np.isclose(a.fillna(np.inf), b.fillna(np.inf), atol=atol, rtol=0))
        if diff.any():
            cols = list(a.index[diff])[:5]
            raise LeakageError(
                f"切り詰め不整合: {d.date()} の特徴量が、全期間で計算した場合と "
                f"{d.date()} までで計算した場合で異なる。列={cols}\n"
                f"  全期間: {a[diff].head(3).to_dict()}\n"
                f"  切り詰め: {b[diff].head(3).to_dict()}\n"
                "この特徴量は未来の情報を使っている。"
            )


def scan_panel_for_constant_future(panel: pd.DataFrame, value_columns: list[str]) -> list[str]:
    """「全期間で同じ値」の列を洗い出す診断。

    財務データを最新値で全期間に broadcast してしまった場合、その列は
    銘柄ごとに定数になる。リーケージのうち最も破壊的な形で、しかも
    IC が異常に高く出るので「うまくいった」と誤認しやすい。
    例外にせずリストで返すのは、意図的に定数な列 (業種コードなど) もあるため。
    """
    suspicious = []
    for col in value_columns:
        if col not in panel.columns:
            continue
        by_code = panel[col].groupby(level="code").nunique(dropna=True)
        if len(by_code) and (by_code <= 1).mean() > 0.9:
            suspicious.append(col)
    return suspicious
