"""
宇宙論的スペクトル解析 × 市場レジーム PoC
==========================================

CMB (宇宙マイクロ波背景放射) 解析の標準手法 — ゆらぎのパワースペクトルと
スペクトル指数 — を市場リターンに適用し、エッジ実装 (src/engine/cosmology.ts)
の妥当性を検証する研究スクリプト。

  1. セクターETFのリターンの Welch パワースペクトル → スペクトル傾き
     (インフレーション宇宙論の n_s 推定と同型の log-log 回帰)
  2. Hurst 指数 (R/S解析 + DFA の2法でクロスチェック)
  3. ローリング解析で「トレンド持続レジーム/平均回帰レジーム」の時系列マップ

実行: python cosmo_spectral_market.py
"""

from __future__ import annotations

import numpy as np
from scipy import signal

try:
    import yfinance as yf
except ImportError:
    yf = None


def load_returns(symbol: str = "XLE", period: str = "5y") -> np.ndarray:
    if yf is not None:
        try:
            close = yf.download(symbol, period=period, progress=False)["Close"]
            close = np.asarray(close).ravel()
            r = np.diff(np.log(close))
            if len(r) > 300:
                return r
        except Exception as e:
            print(f"[warn] yfinance failed ({e}); using synthetic data")
    rng = np.random.default_rng(7)
    # fGn 風の長期記憶をもつ合成系列
    n = 1250
    white = rng.normal(0, 0.01, n)
    kernel = np.arange(1, 60) ** (-0.6)
    return np.convolve(white, kernel / kernel.sum(), mode="same")


# ------------------------------------------------ spectral index (CMB流)
def spectral_slope(returns: np.ndarray) -> float:
    f, p = signal.welch(returns - returns.mean(), nperseg=min(256, len(returns) // 4))
    mask = (f > 0) & (p > 0)
    return float(np.polyfit(np.log(f[mask]), np.log(p[mask]), 1)[0])


# ------------------------------------------------ Hurst (R/S)
def hurst_rs(returns: np.ndarray) -> float:
    n = len(returns)
    sizes = np.unique(np.floor(np.logspace(np.log10(8), np.log10(n // 2), 12)).astype(int))
    log_s, log_rs = [], []
    for size in sizes:
        rs_vals = []
        for i in range(n // size):
            chunk = returns[i * size : (i + 1) * size]
            dev = chunk - chunk.mean()
            z = dev.cumsum()
            r = z.max() - z.min()
            s = chunk.std()
            if s > 1e-12 and r > 0:
                rs_vals.append(r / s)
        if rs_vals:
            log_s.append(np.log(size))
            log_rs.append(np.log(np.mean(rs_vals)))
    return float(np.polyfit(log_s, log_rs, 1)[0])


# ------------------------------------------------ Hurst (DFA)
def hurst_dfa(returns: np.ndarray) -> float:
    y = np.cumsum(returns - returns.mean())
    n = len(y)
    sizes = np.unique(np.floor(np.logspace(np.log10(8), np.log10(n // 4), 12)).astype(int))
    log_s, log_f = [], []
    for size in sizes:
        segs = n // size
        rms = []
        for i in range(segs):
            seg = y[i * size : (i + 1) * size]
            t = np.arange(size)
            trend = np.polyval(np.polyfit(t, seg, 1), t)
            rms.append(np.sqrt(np.mean((seg - trend) ** 2)))
        if rms:
            log_s.append(np.log(size))
            log_f.append(np.log(np.mean(rms)))
    return float(np.polyfit(log_s, log_f, 1)[0])


def main() -> None:
    for symbol in ["XLK", "XLE", "XLF", "GLD"]:
        r = load_returns(symbol)
        slope = spectral_slope(r)
        h_rs = hurst_rs(r)
        h_dfa = hurst_dfa(r)
        regime = "トレンド持続" if h_dfa > 0.55 else "平均回帰" if h_dfa < 0.45 else "中立"
        print(
            f"{symbol:5s}  spectral_slope={slope:+.3f}  "
            f"Hurst(R/S)={h_rs:.3f}  Hurst(DFA)={h_dfa:.3f}  → {regime}"
        )

    # ローリング・レジームマップ (直近2年、63日窓)
    r = load_returns("XLK")
    win = 63
    print("\nXLK rolling regime (直近12窓):")
    points = []
    for i in range(max(win, len(r) - 12 * 21), len(r), 21):
        seg = r[i - win : i]
        if len(seg) == win:
            points.append(hurst_dfa(seg))
    bar = "".join("▲" if h > 0.55 else "▼" if h < 0.45 else "─" for h in points)
    print(f"  {bar}   (▲=トレンド持続 ─=中立 ▼=平均回帰)")


if __name__ == "__main__":
    main()
