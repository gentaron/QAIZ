import type { CosmoSpectral } from "../types.ts";

/**
 * 宇宙論的スペクトル解析エンジン。
 *
 * CMB (宇宙マイクロ波背景放射) の解析では、ゆらぎのパワースペクトルの
 * 傾き (スペクトル指数) が宇宙の生成メカニズムを語る。
 * 同じ道具立てを市場リターンの「ゆらぎ」に適用する:
 *
 *  - Hurst 指数 (R/S解析): 時系列の長期記憶。
 *      H > 0.5 → トレンド持続 (モメンタムが効く環境)
 *      H < 0.5 → 平均回帰 (逆張りが効く環境)
 *  - スペクトル傾き: 対数パワースペクトルの対数周波数に対する回帰係数。
 *      強い負の傾き (赤色ノイズ寄り) → 低周波=長期変動が支配的
 */

/** R/S 解析による Hurst 指数の推定 */
export function hurstExponent(returns: number[]): number {
  const n = returns.length;
  if (n < 32) return 0.5;

  const sizes: number[] = [];
  for (let s = 8; s <= Math.floor(n / 2); s = Math.floor(s * 1.6)) {
    sizes.push(s);
  }
  const logS: number[] = [];
  const logRS: number[] = [];

  for (const size of sizes) {
    const chunks = Math.floor(n / size);
    if (chunks < 1) continue;
    let rsSum = 0;
    let rsCount = 0;
    for (let cIdx = 0; cIdx < chunks; cIdx++) {
      const chunk = returns.slice(cIdx * size, (cIdx + 1) * size);
      const mean = chunk.reduce((a, b) => a + b, 0) / chunk.length;
      let cum = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      let sqSum = 0;
      for (const r of chunk) {
        const dev = r - mean;
        cum += dev;
        if (cum > maxCum) maxCum = cum;
        if (cum < minCum) minCum = cum;
        sqSum += dev * dev;
      }
      const std = Math.sqrt(sqSum / chunk.length);
      const range = maxCum - minCum;
      if (std > 1e-12 && range > 0) {
        rsSum += range / std;
        rsCount++;
      }
    }
    if (rsCount > 0) {
      logS.push(Math.log(size));
      logRS.push(Math.log(rsSum / rsCount));
    }
  }
  if (logS.length < 3) return 0.5;
  const h = linearSlope(logS, logRS);
  return Math.max(0, Math.min(1, h));
}

/**
 * 離散フーリエ変換 (素朴なO(n²)実装 — n≈120なのでエッジでも十分軽い) で
 * パワースペクトルを求め、log-log 回帰の傾きを返す。
 */
export function spectralSlope(returns: number[]): number {
  const n = returns.length;
  if (n < 32) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const x = returns.map((r) => r - mean);

  const half = Math.floor(n / 2);
  const logF: number[] = [];
  const logP: number[] = [];
  for (let k = 1; k <= half; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      re += x[t] * Math.cos(ang);
      im += x[t] * Math.sin(ang);
    }
    const power = (re * re + im * im) / n;
    if (power > 1e-15) {
      logF.push(Math.log(k / n));
      logP.push(Math.log(power));
    }
  }
  if (logF.length < 4) return 0;
  return linearSlope(logF, logP);
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  return den > 1e-12 ? num / den : 0;
}

export function computeCosmoSpectral(returns: number[]): CosmoSpectral {
  return {
    hurst: hurstExponent(returns),
    spectralSlope: spectralSlope(returns.slice(-120)),
  };
}
