"""合成データ生成器 — **テストとパイプライン検証専用**。

## これは研究データではない

ここで作るのは架空の市場である。合成データで出た IC やシャープは
**市場に関する発見を 1 ミリも含まない**。埋め込んだ信号を検出できたかを
確認するための器具でしかない。

生成物には `synthetic=True` のフラグが付き、`experiments` 側は
このフラグが立っているデータで研究レポートを書かない
(`ExperimentResult.data_is_synthetic` が True のレポートには
「これは合成データによる配管テストであり、投資判断に使えない」という
但し書きが必ず入る)。

## それでも合成データが要る理由

1. **パイプラインの検証**。「信用残に予測力がある世界」を人工的に作れば、
   パイプラインがそれを検出できるかを確認できる。検出できないなら、
   実データで何も出なかったときに「効果が無かった」のか
   「パイプラインが壊れている」のか区別できない。
2. **リーケージ検出器の検証**。わざと未来を混ぜたデータを作り、
   検出器が落ちることを確認する。落ちない検出器は無いのと同じ。
3. **オフラインでの再現性**。ネットワークもAPIキーも無い環境
   (CI を含む) で全テストが通る。

すべて seed 固定。同じ seed なら何度回しても同じデータになる。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..calendar import JST


@dataclass
class SyntheticConfig:
    n_codes: int = 60
    n_days: int = 500
    #: 既定の開始日は、min_history_days=252 を満たしてなお十分な評価日数が
    #: 研究期間 (〜2022-12-31) の内側に残るように選んである。
    start: str = "2019-01-04"
    seed: int = 20260910
    #: 埋め込む「信用買残変化 → 将来リターン」の効果の強さ (0 で無効果)
    margin_effect: float = 0.0
    #: 市場成分の大きさ。日本株の日次リターンは市場成分が支配的
    market_vol: float = 0.010
    idio_vol: float = 0.016
    n_sectors: int = 6


def make_market(cfg: SyntheticConfig | None = None) -> dict:
    """合成市場一式を返す。

    Returns
    -------
    dict with keys:
        bars           : 日次OHLCV (縦持ち, `prices.build_price_panel` に渡せる)
        margin_raw     : 週次信用残の生データ (normalize.margin_frame に渡せる)
        listed         : 銘柄マスター
        sectors        : code -> sector
        synthetic      : True (必ず立つ)
        embedded_effect: 埋め込んだ効果の強さ
    """
    cfg = cfg or SyntheticConfig()
    rng = np.random.default_rng(cfg.seed)

    # 営業日: 月〜金のみ (祝日は作らない。カレンダーは価格から導出されるので
    # 「祝日が無い市場」として一貫していればよい)
    days = pd.bdate_range(cfg.start, periods=cfg.n_days, freq="C")
    codes = [f"{1000 + i * 7}" for i in range(cfg.n_codes)]
    sectors = pd.Series(
        [f"S{i % cfg.n_sectors}" for i in range(cfg.n_codes)], index=codes, name="sector"
    )

    # 週次の信用残 (金曜基準)。ランダムウォークに平均回帰を混ぜる
    weeks = pd.DatetimeIndex([d for d in days if d.dayofweek == 4])
    n_w = len(weeks)
    long_bal = np.zeros((n_w, cfg.n_codes))
    short_bal = np.zeros((n_w, cfg.n_codes))
    level_l = rng.lognormal(11.0, 1.0, cfg.n_codes)
    level_s = rng.lognormal(10.0, 1.0, cfg.n_codes)
    for w in range(n_w):
        level_l = np.maximum(1.0, level_l * np.exp(rng.normal(0, 0.10, cfg.n_codes)))
        level_s = np.maximum(1.0, level_s * np.exp(rng.normal(0, 0.12, cfg.n_codes)))
        long_bal[w] = level_l
        short_bal[w] = level_s

    long_df = pd.DataFrame(long_bal, index=weeks, columns=codes)
    weekly_chg = (long_df / long_df.shift(4) - 1.0).replace([np.inf, -np.inf], np.nan)

    # 日次リターン: 市場成分 + セクター成分 + 個別成分 (+ 埋め込み効果)
    market = rng.normal(0.0002, cfg.market_vol, len(days))
    sec_ids = pd.factorize(sectors)[0]
    sector_ret = rng.normal(0, 0.006, (len(days), cfg.n_sectors))
    idio = rng.normal(0, cfg.idio_vol, (len(days), cfg.n_codes))

    rets = market[:, None] + sector_ret[:, sec_ids] + idio

    if abs(cfg.margin_effect) > 1e-12:
        # 「公表済みの信用買残変化」が将来リターンに効く世界を作る。
        # 公表は基準日(金)の3営業日後と仮定して埋め込む — こうしておくと、
        # PIT 結合が正しければ検出でき、間違って基準日で結合すると
        # 「効果が強すぎる」形で現れる (リーケージ検出のテストになる)。
        signal = pd.DataFrame(np.nan, index=days, columns=codes)
        for w_i, w_day in enumerate(weeks):
            pos = days.searchsorted(w_day) + 3
            if pos < len(days):
                signal.iloc[pos] = weekly_chg.iloc[w_i].to_numpy()
        signal = signal.ffill()
        z = signal.sub(signal.mean(axis=1), axis=0).div(
            signal.std(axis=1).replace(0, np.nan), axis=0
        )
        rets = rets + cfg.margin_effect * np.nan_to_num(z.to_numpy(), nan=0.0)

    prices = 1000.0 * np.exp(np.cumsum(rets, axis=0))
    volume = rng.lognormal(12.0, 0.8, (len(days), cfg.n_codes))

    bars = []
    for j, code in enumerate(codes):
        c = prices[:, j]
        o = c * (1 + rng.normal(0, 0.002, len(days)))
        h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.004, len(days))))
        low = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.004, len(days))))
        bars.append(pd.DataFrame({
            "date": days, "code": code, "open": o, "high": h, "low": low, "close": c,
            "volume": volume[:, j], "turnover": volume[:, j] * c,
            "adjustment_factor": 1.0,
        }))
    bars_df = pd.concat(bars, ignore_index=True)

    margin_raw = []
    for w_i, w_day in enumerate(weeks):
        for j, code in enumerate(codes):
            margin_raw.append({
                "Date": w_day.strftime("%Y-%m-%d"),
                "Code": code,
                "LongMarginTradeVolume": float(long_bal[w_i, j]),
                "ShortMarginTradeVolume": float(short_bal[w_i, j]),
            })

    listed = pd.DataFrame({
        "Code": codes,
        "CompanyName": [f"合成銘柄{c}" for c in codes],
        "MarketCodeName": "プライム",
        "Sector33CodeName": sectors.to_numpy(),
        "ListingDate": cfg.start,
        "TradingUnit": 100,
    })

    return {
        "bars": bars_df,
        "margin_raw": pd.DataFrame(margin_raw),
        "listed": listed,
        "sectors": sectors,
        "synthetic": True,
        "embedded_effect": cfg.margin_effect,
        "config": cfg,
    }


def make_leaky_pit_frame(cfg: SyntheticConfig | None = None) -> pd.DataFrame:
    """わざとリーケージを仕込んだ PIT フレーム。検出器のテスト用。

    `available_at` を基準日と同じにしてある = 公表前に使えることになっている。
    `leakage` の検出器がこれを見逃したら、その検出器は機能していない。
    """
    market = make_market(cfg)
    raw = market["margin_raw"].copy()
    raw["available_at"] = pd.to_datetime(raw["Date"]).dt.tz_localize(JST)
    raw["effective_date"] = pd.to_datetime(raw["Date"])
    raw["code"] = raw["Code"]
    raw["margin_long"] = raw["LongMarginTradeVolume"]
    raw["margin_short"] = raw["ShortMarginTradeVolume"]
    return raw[["code", "effective_date", "available_at", "margin_long", "margin_short"]]
