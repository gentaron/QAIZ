"""Point-in-Time データストア。

このプロジェクトで最も重要なファイル。ここが壊れていると、他が全部正しくても
研究結果は 1 つも信用できない。

## 3 つの日付を混同しない

    effective_date  その情報が「いつ時点の事実か」   例: 3月末の信用残
    published_at    公表された時刻                   例: 4/2 16:30
    available_at    我々が実際に使えるようになる時刻   例: 4/2 16:30 (= published_at)
                    ※ 手動ダウンロードや週次バッチなら、それより後になる

バックテストが参照してよいのは **available_at** だけ。effective_date で
結合すると、4/2 に公表される 3/31 時点の情報を 3/31 から使えることになり、
そのぶんだけリターンが水増しされる。これは「バックテストだけ儲かる戦略」の
最も一般的な原因で、しかも数字が綺麗に出るので気付きにくい。

## as-of 結合

    ある判断時刻 t について、code ごとに available_at <= t を満たす最新の 1 行

pandas の `merge_asof(direction="backward")` がまさにこれ。自前で
「日付をずらしてから結合」を書くと、休日・公表遅延の不規則さで必ず穴が開く。

## 陳腐化 (staleness)

「available_at <= t の最新」だけでは足りない。データ提供が 2 年前に止まった
銘柄について、2 年前の値をいつまでも使い続けてしまう。上場廃止銘柄や、
データソースがカバーを外した銘柄で実際に起きる。`max_staleness_days` を
超えた観測は使わない (NaN にする)。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .calendar import JST

REQUIRED_COLUMNS = ("code", "effective_date", "available_at")


class PITError(ValueError):
    """PIT 規約違反。握りつぶさずに落とす。"""


@dataclass
class PITTable:
    """available_at 付きの縦持ちテーブル。

    Attributes
    ----------
    frame:
        `code` / `effective_date` / `available_at` + 値列。
    value_columns:
        値列の名前。ここに挙がっていない列は結合結果に出さない
        (`published_at` のような内部列が特徴量に紛れ込むのを防ぐ)。
    source:
        どこから来たか。結果メタデータに刻む。
    max_staleness_days:
        この日数より古い観測は使わない。週次データなら 30 日程度、
        四半期の財務なら 200 日程度が目安。None で無効 (非推奨)。
    """

    frame: pd.DataFrame
    value_columns: tuple[str, ...]
    source: str
    schema_version: str = "1.0.0"
    max_staleness_days: int | None = 400
    _meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        missing = [c for c in REQUIRED_COLUMNS if c not in self.frame.columns]
        if missing:
            raise PITError(
                f"PIT テーブルに必須列が無い: {missing} / source={self.source}. "
                "available_at の無いデータを PIT テーブルとして扱ってはいけない。"
            )
        unknown = [c for c in self.value_columns if c not in self.frame.columns]
        if unknown:
            raise PITError(f"value_columns に存在しない列が指定された: {unknown}")

        df = self.frame.copy()
        df["code"] = df["code"].astype(str)
        df["effective_date"] = pd.to_datetime(df["effective_date"]).dt.tz_localize(None)
        df["available_at"] = _to_jst(df["available_at"])

        if df["available_at"].isna().any():
            n = int(df["available_at"].isna().sum())
            raise PITError(
                f"available_at が欠損している行が {n} 件ある (source={self.source})。"
                "欠損を effective_date で埋めるのは未来情報の混入なので、行ごと落とすか、"
                "公表規則から保守的に計算すること。"
            )

        # available_at < effective_date は「事実より前に公表された」ことになる。
        # データ変換のバグでしか起きないので、ここで止める。
        bad = df["available_at"].dt.tz_convert(JST).dt.tz_localize(None) < df["effective_date"]
        if bad.any():
            sample = df.loc[bad, ["code", "effective_date", "available_at"]].head(3)
            raise PITError(
                f"available_at が effective_date より前の行が {int(bad.sum())} 件:\n{sample}"
            )

        self.frame = df.sort_values(["available_at", "code"], kind="mergesort").reset_index(drop=True)

    # ------------------------------------------------------------------ #

    @property
    def codes(self) -> list[str]:
        return sorted(self.frame["code"].unique().tolist())

    def coverage(self) -> dict:
        """カバレッジの実態。研究レポートにそのまま貼る用。"""
        f = self.frame
        return {
            "source": self.source,
            "schema_version": self.schema_version,
            "rows": int(len(f)),
            "codes": int(f["code"].nunique()),
            "effective_from": str(f["effective_date"].min().date()) if len(f) else None,
            "effective_to": str(f["effective_date"].max().date()) if len(f) else None,
            "median_publication_lag_days": _median_lag_days(f),
            "value_columns": list(self.value_columns),
            "max_staleness_days": self.max_staleness_days,
        }

    def as_of(self, when, codes: Iterable[str] | None = None) -> pd.DataFrame:
        """判断時刻 `when` に使えた最新の観測を code ごとに 1 行返す。"""
        panel = self.asof_panel(pd.Series([_to_jst_scalar(when)], index=[pd.Timestamp(when).normalize()]), codes)
        return panel.reset_index(level=0, drop=True)

    def asof_panel(
        self,
        decision_at: pd.Series,
        codes: Sequence[str] | None = None,
    ) -> pd.DataFrame:
        """(日付 × 銘柄) のパネルを PIT 準拠で組む。

        Parameters
        ----------
        decision_at:
            index = シグナル日 (naive な日付)、value = 判断締め切り時刻 (tz-aware)。
            `TradingCalendar.decision_timestamps()` の戻り値をそのまま渡す。
        codes:
            対象銘柄。None ならテーブルに存在する全銘柄。

        Returns
        -------
        MultiIndex (date, code) の DataFrame。値列に加えて
        `available_at` と `age_days` (判断時刻から見た観測の古さ) を持つ。
        age_days を残すのは、後段の陳腐化チェックとレポートのため。
        """
        if not isinstance(decision_at.index, pd.DatetimeIndex):
            raise PITError("decision_at の index は DatetimeIndex でなければならない")

        target_codes = list(codes) if codes is not None else self.codes
        if len(target_codes) == 0 or len(decision_at) == 0:
            return _empty_panel(self.value_columns)

        left = pd.MultiIndex.from_product(
            [decision_at.index, target_codes], names=["date", "code"]
        ).to_frame(index=False)
        left["decision_at"] = left["date"].map(decision_at)
        left = left.dropna(subset=["decision_at"])
        left["decision_at"] = _to_jst(left["decision_at"])
        left = left.sort_values(["decision_at", "code"], kind="mergesort")

        right = self.frame[["code", "effective_date", "available_at", *self.value_columns]]

        merged = pd.merge_asof(
            left,
            right,
            left_on="decision_at",
            right_on="available_at",
            by="code",
            direction="backward",
            allow_exact_matches=True,
        )

        # allow_exact_matches=True は「公表時刻ちょうどに判断できる」という仮定。
        # 公表 16:30 / 判断 15:00 のように時刻が別なら影響しないが、両者が同じ
        # 時刻に揃っている構成では 1 ティック分だけ甘くなる。available_at 側に
        # 余裕を持たせる (プロバイダ側で保守的に丸める) 運用にしてある。

        merged["age_days"] = (
            merged["decision_at"] - merged["available_at"]
        ).dt.total_seconds() / 86400.0

        if self.max_staleness_days is not None:
            stale = merged["age_days"] > self.max_staleness_days
            merged.loc[stale, list(self.value_columns)] = np.nan
            merged.loc[stale, "age_days"] = np.nan
            merged.loc[stale, "available_at"] = pd.NaT

        out = merged.set_index(["date", "code"]).sort_index()
        return out[[*self.value_columns, "available_at", "age_days"]]


def _empty_panel(value_columns: Sequence[str]) -> pd.DataFrame:
    idx = pd.MultiIndex.from_arrays([[], []], names=["date", "code"])
    return pd.DataFrame(
        {**{c: pd.Series(dtype=float) for c in value_columns},
         "available_at": pd.Series(dtype="datetime64[ns, Asia/Tokyo]"),
         "age_days": pd.Series(dtype=float)},
        index=idx,
    )


def _to_jst(s: pd.Series) -> pd.Series:
    ts = pd.to_datetime(s, utc=False)
    if getattr(ts.dtype, "tz", None) is None:
        ts = ts.dt.tz_localize(JST)
    return ts.dt.tz_convert(JST)


def _to_jst_scalar(x) -> pd.Timestamp:
    ts = pd.Timestamp(x)
    return ts.tz_localize(JST) if ts.tz is None else ts.tz_convert(JST)


def _median_lag_days(f: pd.DataFrame) -> float | None:
    if len(f) == 0:
        return None
    lag = (
        f["available_at"].dt.tz_convert(JST).dt.tz_localize(None) - f["effective_date"]
    ).dt.total_seconds() / 86400.0
    return float(np.round(lag.median(), 3))


def publication_available_at(
    effective_dates: pd.Series,
    *,
    calendar,
    lag_business_days: int,
    publish_time_jst: str,
    extra_lag_days: int = 0,
) -> pd.Series:
    """公表規則から available_at を機械的に組み立てる。

    「金曜締め・第2営業日 16:30 公表」のような規則を、営業日カレンダー経由で
    実際のタイムスタンプに直す。手で日数を足すと、祝日を挟んだ週で必ずずれる。

    Parameters
    ----------
    effective_dates: 事実の時点 (申込日付・週末残高の基準日など)
    calendar: TradingCalendar
    lag_business_days: 基準日から何営業日後に公表されるか
    publish_time_jst: 公表時刻 "HH:MM"
    extra_lag_days: 保守側の上乗せ営業日数。規則が未検証のときに使う。
    """
    eff = pd.to_datetime(pd.Series(effective_dates)).dt.tz_localize(None).dt.normalize()
    total = int(lag_business_days) + int(extra_lag_days)

    out = []
    for d in eff:
        anchor = calendar.next_session_on_or_after(d)
        if anchor is None:
            out.append(pd.NaT)
            continue
        # 基準日自体が営業日なら、そこから total 営業日後
        base = anchor if anchor == d else calendar.shift(anchor, -1) or anchor
        pub = calendar.shift(base, total)
        out.append(pd.NaT if pub is None else pub)

    pub_days = pd.Series(pd.to_datetime(out), index=eff.index)
    ts = pd.to_datetime(pub_days.dt.strftime("%Y-%m-%d") + " " + publish_time_jst)
    return ts.dt.tz_localize(JST)
