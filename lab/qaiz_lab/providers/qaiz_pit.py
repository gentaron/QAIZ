"""QAIZ Worker の PIT ジャーナルを読むプロバイダ — **この統合の核心**。

## なぜ Worker 側に PIT 記録が要るのか

株価は後から取り直せる。2020年の終値は今日でも取得できる。
**しかしファンダメンタルズとアナリスト予想は取り直せない。**

Yahoo Finance が返す `forwardPE` は「今の予想EPSに基づく今のPER」であって、
「2020年時点で市場が見ていた予想PER」ではない。目標株価・レーティング・
EPS改定も同じで、無料で手に入るのは常に**現在のスナップショット**だけ。

過去の予想PERを買おうとすると有料のPITデータベンダーが必要になる。
ところが QAIZ Worker は **15分ごとに無料枠で動いていて、毎回それを見ている**。
見た瞬間に捨てているだけで、記録すれば
「2026-09-10 06:12 UTC 時点で観測した予想PER」という、後から絶対に
再構成できない Point-in-Time 観測になる。観測時刻がそのまま `available_at`。

    Worker (無料 cron, 15分毎)  →  PIT ジャーナル (append-only)
                                        ↓  /api/pit/export (NDJSON)
                                  研究ラボ (このモジュール)

今日から記録を始めれば、1年後には他では買えない1年ぶんのPIT履歴になる。
**だから「あとで作る」ではなく最初に作る。** 記録していない日は永久に埋まらない。

## 制約 (正直に)

  - 記録開始日より前は当然存在しない。過去のバックテストには使えない
  - 銘柄はシャード巡回なので、1 銘柄あたりの観測頻度は 2 時間に 1 回程度
  - 出所は Yahoo Finance であり、その値自体の正確性は保証されない
  - ユニバースは QAIZ の 135 銘柄で、日本株の全銘柄ではない

これらは `PITTable.coverage()` と `CapabilityReport` に出る。
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from ..pit import PITTable
from .base import CapabilityReport, read_ndjson, retry_with_backoff

#: Worker が書き出すフィールドのうち、研究で使うもの。
#: ここに無いフィールドは PIT テーブルに載せない (載せると
#: 「価格から再計算できる値」と「再取得不能な値」が混ざる)。
FUNDAMENTAL_FIELDS = (
    "trailingPE", "forwardPE", "priceToBook", "priceToSales", "evToEbitda",
    "earningsYield", "fcfYield", "dividendYield", "payoutRatio",
    "returnOnEquity", "returnOnAssets", "returnOnInvestedCapital",
    "grossMargin", "operatingMargin", "profitMargin",
    "debtToEquity", "netDebtToEbitda", "currentRatio",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "marketCap", "sharesOutstanding", "shortPercentOfFloat",
)

CONSENSUS_FIELDS = (
    "recommendationMean", "analystCount", "targetMean", "targetMedian",
    "upsideToTarget", "targetDispersion", "ratingMomentum",
)


@dataclass
class QaizPitProvider:
    """Worker の `/api/pit/export` またはローカルアーカイブを読む。"""

    name: str = "qaiz_pit"
    #: 例: "https://qaiz.<account>.workers.dev"
    base_url: str | None = None
    #: ローカルに落とした NDJSON (.ndjson / .ndjson.gz)
    archive_path: str | Path | None = None

    def probe(self) -> CapabilityReport:
        report = CapabilityReport(
            provider=self.name,
            checked_at=datetime.now(UTC).isoformat(),
            notes=[
                "観測時刻 (observed_at) をそのまま available_at として使う。これは PIT として厳密。",
                "記録開始日より前のデータは存在しない。過去のバックテストには使えない。",
                "ユニバースは QAIZ の分析対象銘柄のみ。日本株の全銘柄ではない。",
                "値の出所は Yahoo Finance。値そのものの正確性は保証されない。",
            ],
        )
        if self.archive_path and Path(self.archive_path).exists():
            report.available["archive"] = str(self.archive_path)
        elif self.archive_path:
            report.unavailable["archive"] = f"ファイルが無い: {self.archive_path}"

        if self.base_url:
            try:
                retry_with_backoff(lambda: _get_json(f"{self.base_url}/api/health"), attempts=2)
                report.available["worker_api"] = f"{self.base_url}/api/pit/export"
            except Exception as e:  # noqa: BLE001
                report.unavailable["worker_api"] = f"{type(e).__name__}: {str(e)[:120]}"
        return report

    # ------------------------------------------------------------------ #

    def fetch_ndjson(self, *, start: str | None = None, end: str | None = None) -> pd.DataFrame:
        """PIT ジャーナルを生の縦持ちで読む。"""
        if self.archive_path and Path(self.archive_path).exists():
            raw = read_ndjson(self.archive_path)
        elif self.base_url:
            qs = []
            if start:
                qs.append(f"from={start}")
            if end:
                qs.append(f"to={end}")
            url = f"{self.base_url}/api/pit/export" + ("?" + "&".join(qs) if qs else "")
            text = retry_with_backoff(lambda: _get_text(url))
            raw = read_ndjson(text)
        else:
            raise RuntimeError(
                "base_url も archive_path も設定されていない。"
                "Worker の URL を渡すか、`python -m qaiz_lab.cli pit-sync` でローカルに落とすこと。"
            )

        if raw.empty:
            raise RuntimeError(
                "PIT ジャーナルが空。Worker 側で記録が始まっているか "
                "(`GET /api/pit/status`) を確認すること。"
                "記録していない期間は後から埋められない。"
            )
        if start:
            raw = raw[raw["date"] >= start]
        if end:
            raw = raw[raw["date"] <= end]
        return raw

    def to_pit_table(
        self,
        raw: pd.DataFrame | None = None,
        *,
        kind: str = "fundamentals",
        codes_from_symbol: bool = True,
    ) -> PITTable:
        """NDJSON を PITTable に直す。

        Parameters
        ----------
        kind: "fundamentals" | "consensus"
        codes_from_symbol:
            `7203.T` → `7203` に直す。J-Quants の銘柄コードと突き合わせるため。
            突き合わせないなら False (シンボルをそのままコードにする)。
        """
        raw = self.fetch_ndjson() if raw is None else raw
        fields = FUNDAMENTAL_FIELDS if kind == "fundamentals" else CONSENSUS_FIELDS
        if kind not in ("fundamentals", "consensus"):
            raise ValueError(f"kind は fundamentals か consensus: {kind}")

        rows = []
        for rec in raw.to_dict("records"):
            payload = rec.get(kind) or {}
            if isinstance(payload, str):
                payload = json.loads(payload)
            if not payload:
                continue
            symbol = str(rec["symbol"])
            code = symbol.split(".")[0] if codes_from_symbol else symbol
            rows.append({
                "code": code,
                "symbol": symbol,
                # 観測日 (JST の営業日)。「その事実がいつ時点のものか」の最良の近似。
                "effective_date": rec["date"],
                # 観測時刻 = 我々が実際に手に入れた時刻。これが available_at。
                "available_at": rec["observed_at"],
                **{f: payload.get(f) for f in fields},
            })

        if not rows:
            raise RuntimeError(f"{kind} を含む PIT レコードが 1 件も無かった")

        df = pd.DataFrame(rows)
        for f in fields:
            df[f] = pd.to_numeric(df[f], errors="coerce")

        # 同一 (code, available_at) が重複したら最後を採る (Worker 側で
        # 同じ観測が二重に書かれた場合の保険)
        df = df.drop_duplicates(subset=["code", "available_at"], keep="last")

        table = PITTable(
            frame=df,
            value_columns=tuple(fields),
            source=f"qaiz_worker_pit:{kind}",
            # ファンダは四半期更新なので、200日より古い観測は使わない
            max_staleness_days=200 if kind == "fundamentals" else 90,
        )
        table._meta["origin"] = "Yahoo Finance via QAIZ Worker cron"
        table._meta["pit_strength"] = (
            "STRICT: available_at は Worker が実際に値を観測した時刻。"
            "推定でも規則からの逆算でもない。"
        )
        return table


def _get_text(url: str, timeout: int = 60) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return res.read().decode("utf-8")


def _get_json(url: str, timeout: int = 30) -> dict:
    return json.loads(_get_text(url, timeout))
