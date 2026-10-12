"""生データ → 正規化データモデル。

## 列名を推測しない

プロバイダの列名は変わる。変わったときに黙って NaN になるのが最悪で、
「信用残に予測力が無かった」という誤った結論が出る。

そこでこのモジュールは:

  1. **候補リストと突き合わせる** (`_pick`)。候補に無ければ例外で止める
  2. 見つけた対応を `mapping` として返し、結果メタデータに残す
  3. 単位・符号の健全性を検査する (負の残高、負の出来高など)

「とりあえず動く」より「間違ったまま動かない」を選ぶ。

## 候補リストの出所

J-Quants の実レスポンスを一次情報で確認できていないため、候補は
**複数の表記ゆれを許す形**にしてある (`Code` / `code` / `LocalCode` など)。
実データで確認できた時点で候補を絞ってよい。絞るほど事故は減る。
"""

from __future__ import annotations

import contextlib

import pandas as pd

from ..pit import PITTable, publication_available_at


class SchemaError(ValueError):
    """列が見つからない・単位がおかしい。推測で埋めずに止める。"""


def _pick(df: pd.DataFrame, candidates: list[str], what: str) -> str:
    lowered = {c.lower().replace("_", ""): c for c in df.columns}
    for cand in candidates:
        key = cand.lower().replace("_", "")
        if key in lowered:
            return lowered[key]
    raise SchemaError(
        f"{what} に対応する列が見つからない。\n"
        f"  探した候補: {candidates}\n"
        f"  実際の列  : {list(df.columns)}\n"
        "列名を推測してリネームすると、対応が間違っていても全部 NaN になるだけで"
        "気付けない。実データの列を確認して候補に足すこと。"
    )


def quotes_frame(raw: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    """日次 OHLCV を正規化する。戻り値は (DataFrame, 列マッピング)。"""
    if raw.empty:
        raise SchemaError("日次価格が空。取得失敗と『データが無い』を区別できないので止める。")

    m = {
        "date": _pick(raw, ["Date", "date", "TradingDate"], "日付"),
        "code": _pick(raw, ["Code", "code", "LocalCode", "Symbol"], "銘柄コード"),
        "open": _pick(raw, ["Open", "open", "AdjustmentOpen"], "始値"),
        "high": _pick(raw, ["High", "high", "AdjustmentHigh"], "高値"),
        "low": _pick(raw, ["Low", "low", "AdjustmentLow"], "安値"),
        "close": _pick(raw, ["Close", "close", "AdjustmentClose"], "終値"),
        "volume": _pick(raw, ["Volume", "volume", "AdjustmentVolume"], "出来高"),
    }
    for opt, cands in (
        ("turnover", ["TurnoverValue", "turnover", "Value", "TradingValue"]),
        ("adjustment_factor", ["AdjustmentFactor", "adjustment_factor"]),
    ):
        with contextlib.suppress(SchemaError):
            m[opt] = _pick(raw, cands, opt)

    out = pd.DataFrame({k: raw[v] for k, v in m.items()})
    out["date"] = pd.to_datetime(out["date"])
    out["code"] = out["code"].astype(str).str.strip()
    for c in [c for c in out.columns if c not in ("date", "code")]:
        out[c] = pd.to_numeric(out[c], errors="coerce")

    _sanity_prices(out)
    return out, m


def _sanity_prices(df: pd.DataFrame) -> None:
    """README 49 のデータ品質検査のうち、価格に関わるもの。"""
    problems = []
    if (df[["open", "high", "low", "close"]] < 0).any().any():
        problems.append("負の価格がある")
    if (df["volume"] < 0).any():
        problems.append("負の出来高がある")
    bad_hl = (df["high"] < df["low"]).sum()
    if bad_hl:
        problems.append(f"高値 < 安値 の行が {bad_hl} 件")
    dup = df.duplicated(subset=["date", "code"]).sum()
    if dup:
        problems.append(f"(date, code) の重複が {dup} 件")
    if df["date"].max() > pd.Timestamp.now().normalize() + pd.Timedelta(days=1):
        problems.append("未来の日付を持つ行がある")
    if problems:
        raise SchemaError("価格データの健全性検査に失敗: " + " / ".join(problems))


def margin_frame(
    raw: pd.DataFrame,
    *,
    calendar,
    publication_lag_business_days: int = 2,
    publish_time_jst: str = "16:30",
    conservative_extra_lag_days: int = 1,
    source: str = "jquants:weekly_margin_interest",
) -> PITTable:
    """週次信用残を PIT テーブルに正規化する。

    **available_at をここで組み立てるのが要点**。生データが持っているのは
    基準日 (申込日付) だけで、それをそのまま日付キーにすると、公表前の
    期間にも値が入る = 未来情報の混入になる。

    公表規則 (第2営業日 16:30) は一次情報で未検証なので、既定で
    `conservative_extra_lag_days=1` を上乗せしてある。規則が確認できて
    かつ感度分析で影響が小さいと分かれば 0 にしてよい。
    """
    if raw.empty:
        raise SchemaError(
            "信用残データが空。R001 はこのデータが無いと実行できない。"
            "取得できなかったのか、その期間に公表が無いのかを切り分けること。"
        )

    m = {
        "effective_date": _pick(
            raw, ["Date", "date", "ApplicationDate", "IssueDate", "PublishedDate"], "基準日(申込日付)"
        ),
        "code": _pick(raw, ["Code", "code", "LocalCode", "IssueCode"], "銘柄コード"),
        "margin_long": _pick(
            raw,
            ["LongMarginTradeVolume", "LongMarginOutstanding", "margin_long", "MarginBuyBalance"],
            "信用買残",
        ),
        "margin_short": _pick(
            raw,
            ["ShortMarginTradeVolume", "ShortMarginOutstanding", "margin_short", "MarginSellBalance"],
            "信用売残",
        ),
    }

    df = pd.DataFrame({k: raw[v] for k, v in m.items()})
    df["effective_date"] = pd.to_datetime(df["effective_date"]).dt.tz_localize(None).dt.normalize()
    df["code"] = df["code"].astype(str).str.strip()
    for c in ("margin_long", "margin_short"):
        df[c] = pd.to_numeric(df[c], errors="coerce")

    neg = ((df["margin_long"] < 0) | (df["margin_short"] < 0)).sum()
    if neg:
        raise SchemaError(
            f"信用残に負の値が {neg} 件ある。残高は非負なので、列の対応が"
            "間違っているか単位が違う可能性が高い。"
        )

    df["available_at"] = publication_available_at(
        df["effective_date"],
        calendar=calendar,
        lag_business_days=publication_lag_business_days,
        publish_time_jst=publish_time_jst,
        extra_lag_days=conservative_extra_lag_days,
    )
    df = df[df["available_at"].notna()]

    table = PITTable(
        frame=df,
        value_columns=("margin_long", "margin_short"),
        source=source,
        # 週次データ。60日以上古い観測を使うのは、公表が止まっている
        # (上場廃止・整理銘柄など) ことを意味するので使わない。
        max_staleness_days=60,
    )
    table._meta["column_mapping"] = m
    table._meta["availability_rule"] = {
        "publication_lag_business_days": publication_lag_business_days,
        "publish_time_jst": publish_time_jst,
        "conservative_extra_lag_days": conservative_extra_lag_days,
        "verification": "UNVERIFIED (公式の公表スケジュールに未到達)",
    }
    return table


def listed_frame(raw: pd.DataFrame) -> pd.DataFrame:
    """銘柄マスターを正規化する (README 9)。"""
    if raw.empty:
        raise SchemaError("銘柄マスターが空")
    m = {
        "code": _pick(raw, ["Code", "code", "LocalCode"], "銘柄コード"),
        "name": _pick(raw, ["CompanyName", "name", "CompanyNameEnglish"], "銘柄名"),
    }
    out = pd.DataFrame({k: raw[v] for k, v in m.items()})
    out["code"] = out["code"].astype(str).str.strip()

    for opt, cands in (
        ("market", ["MarketCodeName", "MarketCode", "market", "Section"]),
        ("sector33", ["Sector33CodeName", "Sector33Code", "sector33"]),
        ("sector17", ["Sector17CodeName", "Sector17Code", "sector17"]),
        ("listing_date", ["ListingDate", "listing_date"]),
        ("delisting_date", ["DelistingDate", "delisting_date"]),
        ("lot_size", ["TradingUnit", "lot_size"]),
        ("margin_code", ["MarginCode", "MarginCodeName"]),
    ):
        try:
            col = _pick(raw, cands, opt)
            out[opt] = raw[col]
        except SchemaError:
            out[opt] = pd.NA
    return out
