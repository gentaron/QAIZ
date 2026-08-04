import type { Bar, CosmoSpectral, Momentum, QuantumGeometry } from "../src/types.ts";

/**
 * テスト用の決定論的擬似乱数 (mulberry32)。
 *
 * Math.random() を使うと、落ちたときに再現できないテストになる。
 * 数理エンジンの検証では「同じ入力なら必ず同じ出力」が前提なので、
 * 系列生成側も決定論的でなければ意味がない。
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平均 0 付近の i.i.d. 系列 (ランダムウォークの増分) */
export function whiteNoise(n: number, seed = 1, scale = 0.01): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() - 0.5) * 2 * scale);
}

/** 自己相関を持たせた系列 (H > 0.5 側に寄るはず) */
export function persistent(n: number, seed = 1, phi = 0.85, scale = 0.01): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < n; i++) {
    prev = phi * prev + (r() - 0.5) * 2 * scale;
    out.push(prev);
  }
  return out;
}

/** 符号が交互に反転する系列 (H < 0.5 側に寄るはず) */
export function meanReverting(n: number, seed = 1, scale = 0.01): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) =>
    (i % 2 === 0 ? 1 : -1) * (0.5 + r() * 0.5) * scale
  );
}

/** 終値列から Bar[] を作る (t は 1 日刻み) */
export function bars(closes: number[]): Bar[] {
  const day = 86400;
  return closes.map((c, i) => ({ t: 1_700_000_000 + i * day, c }));
}

/** 一定倍率で伸びる終値列 */
export function trendingCloses(n: number, start = 100, dailyRate = 0.001): number[] {
  const out: number[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c *= 1 + dailyRate;
  }
  return out;
}

/** computeHeatScore の中立入力。ここから 1 要素だけ動かして効果を見る */
export const NEUTRAL_MOMENTUM: Momentum = {
  r1w: 0,
  r1m: 0,
  r3m: 0,
  volAdj: 0,
  trendConsistency: 0.5,
};

export const NEUTRAL_QUANTUM: QuantumGeometry = {
  fidelity: 1,
  fubiniStudy: 0,
  qfiProxy: 0,
  entropy: 0,
};

export const NEUTRAL_COSMO: CosmoSpectral = {
  hurst: 0.5,
  spectralSlope: 0,
};
