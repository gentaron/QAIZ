"""ユニバース構築 — 生存者バイアスを避けるための層。

## 原則

**その日に投資可能だった銘柄だけを、その日のユニバースにする。**

やってはいけないこと:
  - 現在の上場銘柄リストで過去をバックテストする
  - 「途中で上場廃止になったから」とデータを消す
  - 流動性フィルタを**全期間の平均**で当てる (2015年に薄かった銘柄が
    2025年の出来高で通ってしまう)

流動性フィルタはその日時点の過去 20 日で当てる。上場・廃止は銘柄マスターの
`listing_date` / `delisting_date` で判定する。マスターに廃止銘柄が
入っていない構成では、それを検出して `survivorship_bias="PRESENT"` を返す。
黙って進めない。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .prices import PricePanel


@dataclass
class UniverseRules:
    min_adv_jpy: float = 100_000_000
    adv_window_days: int = 20
    min_price_jpy: float = 100
    min_history_days: int = 252
    min_days_since_listing: int = 60
    refresh: str = "monthly"
    exclude_codes: tuple[str, ...] = ()

    @classmethod
    def from_config(cls, cfg: dict) -> UniverseRules:
        liq = cfg.get("liquidity", {})
        lst = cfg.get("listing", {})
        return cls(
            min_adv_jpy=float(liq.get("min_adv_jpy", 1e8)),
            adv_window_days=int(liq.get("adv_window_days", 20)),
            min_price_jpy=float(liq.get("min_price_jpy", 100)),
            min_history_days=int(liq.get("min_history_days", 252)),
            min_days_since_listing=int(lst.get("min_days_since_listing", 60)),
            refresh=str(cfg.get("rebalance", {}).get("universe_refresh", "monthly")),
        )


@dataclass
class UniverseResult:
    """日付 × 銘柄の真偽マスク + 診断。"""

    membership: pd.DataFrame
    diagnostics: dict = field(default_factory=dict)

    def codes_on(self, date) -> list[str]:
        row = self.membership.loc[pd.Timestamp(date)]
        return list(row[row].index)

    def masked(self, frame: pd.DataFrame) -> pd.DataFrame:
        """ユニバース外を NaN にする。

        0 で埋めてはいけない。0 は「スコア 0 の銘柄」であって
        「対象外」ではない。
        """
        m = self.membership.reindex(index=frame.index, columns=frame.columns).fillna(False)
        return frame.where(m)


def build_universe(
    panel: PricePanel,
    rules: UniverseRules,
    *,
    listed: pd.DataFrame | None = None,
) -> UniverseResult:
    """日次のユニバース所属マスクを作る。

    Parameters
    ----------
    listed:
        銘柄マスター。`code` / `listing_date` / `delisting_date` を見る。
        None なら上場情報による絞り込みを行わず、診断にその旨を残す。
    """
    close = panel.close
    adv = panel.adv(rules.adv_window_days)

    liquid = adv >= rules.min_adv_jpy
    priced = close >= rules.min_price_jpy

    # その日までに何本のバーがあるか (min_history_days の判定)
    history = close.notna().cumsum()
    enough_history = history >= rules.min_history_days

    member = liquid & priced & enough_history

    diagnostics: dict = {
        "rules": {
            "min_adv_jpy": rules.min_adv_jpy,
            "min_price_jpy": rules.min_price_jpy,
            "min_history_days": rules.min_history_days,
            "min_days_since_listing": rules.min_days_since_listing,
        },
        "survivorship_bias": "UNKNOWN",
    }

    if listed is not None and "code" in listed.columns:
        info = listed.set_index(listed["code"].astype(str))
        has_delisting = (
            "delisting_date" in info.columns and info["delisting_date"].notna().any()
        )
        diagnostics["survivorship_bias"] = "MITIGATED" if has_delisting else "PRESENT"
        diagnostics["survivorship_note"] = (
            "銘柄マスターに上場廃止日を持つ銘柄が含まれている。過去のユニバースに"
            "廃止銘柄が入っている前提で計算した。"
            if has_delisting else
            "**銘柄マスターに上場廃止銘柄が 1 件も無い。** 現在上場している銘柄"
            "だけで過去を評価している可能性が高く、リターンは構造的に過大評価される。"
            "この結果から実運用の期待値を読み取ってはいけない。"
        )

        listing = pd.to_datetime(info.get("listing_date"), errors="coerce")
        delisting = pd.to_datetime(info.get("delisting_date"), errors="coerce")
        dates = pd.DatetimeIndex(member.index)

        for code in member.columns:
            if code not in info.index:
                continue
            ld = listing.get(code) if listing is not None else pd.NaT
            dd = delisting.get(code) if delisting is not None else pd.NaT
            if pd.notna(ld):
                cutoff = pd.Timestamp(ld) + pd.Timedelta(days=rules.min_days_since_listing)
                member.loc[dates < cutoff, code] = False
            if pd.notna(dd):
                member.loc[dates >= pd.Timestamp(dd), code] = False
    else:
        diagnostics["survivorship_note"] = (
            "銘柄マスターが渡されていないので、上場・廃止による絞り込みを行っていない。"
            "生存者バイアスの有無を判定できない。"
        )

    if rules.exclude_codes:
        for c in rules.exclude_codes:
            if c in member.columns:
                member[c] = False

    # 月次リフレッシュ: 月初の判定をその月中固定する。日次で入れ替えると
    # 流動性の境界にいる銘柄が出入りして、回転率がユニバース定義由来で膨らむ。
    if rules.refresh == "monthly":
        member = _freeze_monthly(member)

    counts = member.sum(axis=1)
    # 系列の先頭は min_history_days を満たさないので必然的に 0 になる。
    # そこを「ユニバースが縮んだ」と報告しても意味が無いので、
    # 実際に稼働している日 (1銘柄以上) の統計を別に出す。
    active = counts[counts > 0]
    diagnostics.update({
        "mean_size": float(counts.mean()) if len(counts) else 0.0,
        "min_size_all_dates": int(counts.min()) if len(counts) else 0,
        "min_size_active": int(active.min()) if len(active) else 0,
        "max_size": int(counts.max()) if len(counts) else 0,
        "active_dates": int(len(active)),
        "warmup_dates": int(len(counts) - len(active)),
        "refresh": rules.refresh,
    })
    if len(active) and active.min() < 20:
        diagnostics["warning"] = (
            f"稼働日でもユニバースが最小 {int(active.min())} 銘柄まで縮む日がある。"
            "クロスセクション分析は銘柄数が少ない日で不安定になる。"
        )

    return UniverseResult(membership=member.fillna(False), diagnostics=diagnostics)


def _freeze_monthly(member: pd.DataFrame) -> pd.DataFrame:
    idx = pd.DatetimeIndex(member.index)
    period = idx.to_period("M")
    first_of_month = ~pd.Series(period, index=idx).duplicated()
    frozen = member.where(pd.Series(first_of_month, index=idx), other=np.nan)
    return frozen.ffill().fillna(False).astype(bool)
