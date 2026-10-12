"""J-Quants API プロバイダ (Free プラン前提)。

## このファイルで守っていること

**エンドポイントの契約プラン別可否を、コードの前提にしていない。**

本リポジトリを作成した環境からは J-Quants の公式仕様ページに到達できず、
どのエンドポイントが Free プランで使えるかを一次情報で確認できていない。
そこで:

  - エンドポイントのパスは定数として 1 箇所にまとめ、`VERIFIED` フラグで
    「一次情報で確認済みか」を明示する
  - `probe()` が実際に叩いて、使えたものだけを `CapabilityReport.available`
    に入れる
  - 研究側は `report.require("weekly_margin_interest")` で必要なデータの
    存在を要求し、無ければ例外で止まる

想像で「使えるはず」と実装して、実行時に空の DataFrame が返り、
バックテストがその期間を静かにスキップする、という状態を作らない。

## Free プランについて (二次情報・要確認)

検索結果から得た情報であり、**公式ページでの確認が済んでいない**:

  - データ期間: 約2年
  - 配信遅延: 約12週間
  - CSV 取得: 不可 (取引カレンダーを除く)
  - レートリミット: 分あたり数リクエスト程度

12週間の遅延が事実なら、この構成では **実運用シグナルは作れない**。
研究 (過去データでの検証) には支障ないが、Paper Trading に進む段階で
別のデータ入手経路が必要になる。この制約は結果メタデータに刻まれる。

## 認証

リフレッシュトークン → ID トークンの 2 段。ID トークンは有効期限が短いので
メモリ上に持ち、期限が切れたら取り直す。**トークンをファイルに書き出さない**
(リポジトリに混入する事故を防ぐ)。認証情報は環境変数から読む:

    JQUANTS_REFRESH_TOKEN   (推奨)
    JQUANTS_MAIL_ADDRESS / JQUANTS_PASSWORD  (リフレッシュトークン取得用)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime

import pandas as pd

from .base import Cache, CapabilityReport, RateLimiter, retry_with_backoff

BASE_URL = "https://api.jquants.com/v1"

#: エンドポイント定義。VERIFIED=False は「一次情報で未確認」の意味。
#: 確認できたものから True にしていく。True/False はコードの分岐には使わず、
#: レポートに出す注記として使う (可否は probe() の実測で決める)。
ENDPOINTS: dict[str, dict] = {
    "listed_info":            {"path": "/listed/info",                    "verified": False},
    "daily_quotes":           {"path": "/prices/daily_quotes",            "verified": False},
    "trading_calendar":       {"path": "/markets/trading_calendar",       "verified": False},
    "weekly_margin_interest": {"path": "/markets/weekly_margin_interest", "verified": False},
    "short_selling":          {"path": "/markets/short_selling",          "verified": False},
    "trades_spec":            {"path": "/markets/trades_spec",            "verified": False},
    "statements":             {"path": "/fins/statements",                "verified": False},
    "announcement":           {"path": "/fins/announcement",              "verified": False},
}


class JQuantsError(RuntimeError):
    pass


@dataclass
class JQuantsProvider:
    """J-Quants の薄いクライアント。

    Parameters
    ----------
    rate_limit_per_minute:
        Free プランのレートリミットは未確認なので、既定を保守的に 4 にしてある。
        公式値を確認したら上げてよい。下げる方向の誤りは時間を損するだけだが、
        上げる方向の誤りは 429 を食らって取得が虫食いになる。
    """

    name: str = "jquants"
    refresh_token: str | None = None
    rate_limit_per_minute: int = 4
    cache_dir: str = "data/cache/jquants"
    _id_token: str | None = None
    _id_token_at: float = 0.0

    def __post_init__(self) -> None:
        self.refresh_token = self.refresh_token or os.environ.get("JQUANTS_REFRESH_TOKEN")
        self.cache = Cache(self.cache_dir)
        self.limiter = RateLimiter(self.rate_limit_per_minute, 60.0)

    # -------------------------------------------------------------- 認証 --

    def _ensure_token(self) -> str:
        if self._id_token:
            return self._id_token
        if not self.refresh_token:
            raise JQuantsError(
                "JQUANTS_REFRESH_TOKEN が設定されていない。\n"
                "J-Quants に登録して取得したリフレッシュトークンを環境変数に入れること。"
                "無料プランでもトークンは必要。トークンをコードやリポジトリに書かない。"
            )
        qs = urllib.parse.urlencode({"refreshtoken": self.refresh_token})
        req = urllib.request.Request(
            f"{BASE_URL}/token/auth_refresh?{qs}", data=b"", method="POST"
        )
        raw = retry_with_backoff(lambda: _http(req))
        token = raw.get("idToken")
        if not token:
            raise JQuantsError(f"idToken が返らなかった: {list(raw)}")
        self._id_token = token
        return token

    def _get(self, path: str, params: dict | None = None) -> dict:
        self.limiter.acquire()
        token = self._ensure_token()
        qs = ""
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                qs = "?" + urllib.parse.urlencode(clean)
        req = urllib.request.Request(
            f"{BASE_URL}{path}{qs}", headers={"Authorization": f"Bearer {token}"}
        )
        return retry_with_backoff(lambda: _http(req))

    def _paged(self, path: str, params: dict, key: str) -> list[dict]:
        """`pagination_key` を辿って全件取る。"""
        rows: list[dict] = []
        pk = None
        for _ in range(200):  # 暴走防止
            payload = self._get(path, {**params, "pagination_key": pk})
            rows.extend(payload.get(key, []))
            pk = payload.get("pagination_key")
            if not pk:
                break
        return rows

    # ------------------------------------------------------------ probe --

    def probe(self, sample_date: str | None = None) -> CapabilityReport:
        """各エンドポイントを実際に 1 回ずつ叩いて、可否を記録する。

        レートリミットを食うので、研究のたびに呼ばない。1 日 1 回、
        結果を `data/cache/jquants/capability.json` に落として使い回す。
        """
        report = CapabilityReport(
            provider=self.name,
            checked_at=datetime.now(UTC).isoformat(),
            notes=[
                "Free プランのデータ期間・遅延は二次情報 (約2年 / 約12週遅延)。公式仕様での確認が未了。",
                "エンドポイントのパスも一次情報で未確認 (ENDPOINTS の verified フラグを参照)。",
                "ここに列挙されていないデータは『取れない』であって『まだ実装していない』ではない。",
            ],
        )
        for key, spec in ENDPOINTS.items():
            try:
                params = {"date": sample_date} if sample_date and key != "listed_info" else {}
                self._get(spec["path"], params)
                report.available[key] = spec["path"]
            except Exception as e:  # noqa: BLE001 — 失敗理由をそのまま記録する
                report.unavailable[key] = f"{type(e).__name__}: {str(e)[:120]}"
        return report

    # ------------------------------------------------------------- data --

    def listed_info(self, date: str | None = None) -> pd.DataFrame:
        """銘柄マスター。**その日時点の上場銘柄**を取るために date を渡す。

        date を省くと最新時点のマスターになり、過去のバックテストに使うと
        生存者バイアスが入る。省略できるようにはしてあるが、`universe.py` は
        必ず日付つきで呼ぶ。
        """
        rows = self.cache.wrap(
            "listed_info", {"date": date},
            lambda: pd.DataFrame(self._paged(ENDPOINTS["listed_info"]["path"], {"date": date}, "info")),
        )
        return rows

    def daily_quotes(self, code: str | None = None, *, start: str, end: str) -> pd.DataFrame:
        params = {"code": code, "from": start, "to": end} if code else {"date": start}
        return self.cache.wrap(
            "daily_quotes", {"code": code, "start": start, "end": end},
            lambda: pd.DataFrame(
                self._paged(ENDPOINTS["daily_quotes"]["path"], params, "daily_quotes")
            ),
        )

    def weekly_margin_interest(self, code: str | None = None, *, start: str, end: str) -> pd.DataFrame:
        """週次の信用取引残高。R001 の主データ。

        **列名を検証してから使う**。想像した列名でリネームすると、
        列が違ったときに全部 NaN になり、「信用残に予測力が無い」という
        誤った結論が出る。列の検証は `normalize.margin_frame()` が行う。
        """
        params = {"code": code, "from": start, "to": end} if code else {"date": start}
        return self.cache.wrap(
            "weekly_margin", {"code": code, "start": start, "end": end},
            lambda: pd.DataFrame(
                self._paged(
                    ENDPOINTS["weekly_margin_interest"]["path"], params, "weekly_margin_interest"
                )
            ),
        )


def _http(req: urllib.request.Request, timeout: int = 30) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise JQuantsError(f"HTTP {e.code} {e.reason} for {req.full_url.split('?')[0]}") from e
    except urllib.error.URLError as e:
        raise JQuantsError(f"接続失敗: {e.reason}") from e
