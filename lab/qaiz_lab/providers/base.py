"""データプロバイダの共通契約とローカルキャッシュ。

## 差し替え可能にする理由

無料構成 (J-Quants Free / Stooq / QAIZ PIT) で研究を組み立てておいて、
後から有料データに差し替えられるようにしておく。差し替えの単位を
**正規化データモデル** に置くことで、上位の特徴量・バックテストは
プロバイダを知らずに済む。

    Provider → NormalizedFrame → FeatureEngine → Research

## 「使えると仮定しない」

エンドポイントが契約プランで使えるかどうかを**コードの前提にしない**。
`probe()` が実際に叩いて可否を記録し、使えないものは
`CapabilityReport.unavailable` に入る。研究側はそれを見て、
「このデータが無いので R001 は実行できない」と判断できる。

想像した仕様で実装して、動かないときに「なぜか空が返る」状態にするのが
最悪。取れないなら取れないと言う。
"""

from __future__ import annotations

import gzip
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import pandas as pd

DEFAULT_CACHE_DIR = Path("data/cache")


@dataclass
class CapabilityReport:
    """このプロバイダで実際に何が取れたかの記録。研究結果に添付する。"""

    provider: str
    checked_at: str
    available: dict[str, str] = field(default_factory=dict)
    unavailable: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def require(self, key: str) -> None:
        if key not in self.available:
            reason = self.unavailable.get(key, "未確認")
            raise RuntimeError(
                f"{self.provider}: '{key}' が利用できない ({reason})。\n"
                "取得できないデータを、あるものとして扱ってはいけない。"
                "研究をここで止めて、無料の代替手段を検討すること。"
            )

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "checked_at": self.checked_at,
            "available": self.available,
            "unavailable": self.unavailable,
            "notes": self.notes,
        }


class Provider(Protocol):
    """最小契約。実装しないメソッドは NotImplementedError を投げる (空を返さない)。"""

    name: str

    def probe(self) -> CapabilityReport: ...
    def listed_info(self, date: str | None = None) -> pd.DataFrame: ...
    def daily_quotes(self, code: str | None = None, *, start: str, end: str) -> pd.DataFrame: ...


class Cache:
    """ローカルキャッシュ。無料 API のレート制限を守るための土台。

    同じ期間・同じ銘柄を二度取りに行かない。キーは引数のハッシュ。
    形式は pyarrow があれば Parquet、無ければ gzip CSV に自動で落とす
    (Parquet のために依存を 1 本増やすほどの差は、この規模では出ない)。
    """

    def __init__(self, root: str | Path = DEFAULT_CACHE_DIR, ttl_seconds: int | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl_seconds
        try:
            import pyarrow  # noqa: F401

            self.fmt = "parquet"
        except ImportError:
            self.fmt = "csv.gz"

    def _path(self, namespace: str, key: dict) -> Path:
        digest = hashlib.sha256(
            json.dumps(key, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()[:20]
        d = self.root / namespace
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{digest}.{self.fmt}"

    def get(self, namespace: str, key: dict) -> pd.DataFrame | None:
        p = self._path(namespace, key)
        if not p.exists():
            return None
        if self.ttl is not None and time.time() - p.stat().st_mtime > self.ttl:
            return None
        return pd.read_parquet(p) if self.fmt == "parquet" else pd.read_csv(p, compression="gzip")

    def put(self, namespace: str, key: dict, df: pd.DataFrame) -> None:
        p = self._path(namespace, key)
        if self.fmt == "parquet":
            df.to_parquet(p, index=False)
        else:
            df.to_csv(p, index=False, compression="gzip")

    def wrap(self, namespace: str, key: dict, fetch: Callable[[], pd.DataFrame]) -> pd.DataFrame:
        hit = self.get(namespace, key)
        if hit is not None:
            return hit
        df = fetch()
        self.put(namespace, key, df)
        return df


class RateLimiter:
    """トークンバケット。無料プランのレート制限を超えないための最低限。

    「1分5リクエスト」のような制限では、素朴に sleep(12) を挟むより
    バケットのほうがバースト後に落ち着くぶん総所要時間が短い。
    """

    def __init__(self, calls: int, per_seconds: float):
        self.calls = max(1, calls)
        self.per = per_seconds
        self._stamps: list[float] = []

    def acquire(self) -> None:
        now = time.monotonic()
        self._stamps = [t for t in self._stamps if now - t < self.per]
        if len(self._stamps) >= self.calls:
            time.sleep(max(0.0, self.per - (now - self._stamps[0])) + 0.01)
            return self.acquire()
        self._stamps.append(now)


def retry_with_backoff(
    fn: Callable[[], Any],
    *,
    attempts: int = 4,
    base_delay: float = 2.0,
    retry_on: tuple[type[Exception], ...] = (Exception,),
) -> Any:
    """指数バックオフ付きリトライ (2s, 4s, 8s, 16s)。

    最後まで失敗したら例外を投げる。**空の DataFrame を返さない**。
    空を返すと、取得失敗が「その期間はデータが無い」と区別できなくなり、
    バックテストがその期間だけ静かにスキップされる。
    """
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn()
        except retry_on as e:  # noqa: PERF203
            last = e
            if i < attempts - 1:
                time.sleep(base_delay * (2**i))
    raise RuntimeError(f"{attempts} 回リトライしても取得できなかった: {last}") from last


def read_ndjson(path_or_text: str | Path) -> pd.DataFrame:
    """NDJSON (1行1レコード) を読む。QAIZ Worker の PIT エクスポート形式。"""
    p = Path(path_or_text)
    if p.exists():
        opener = gzip.open if p.suffix == ".gz" else open
        with opener(p, "rt", encoding="utf-8") as f:  # type: ignore[operator]
            rows = [json.loads(line) for line in f if line.strip()]
    else:
        rows = [json.loads(line) for line in str(path_or_text).splitlines() if line.strip()]
    return pd.DataFrame(rows)
