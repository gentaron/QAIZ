import type { Bar } from "../src/types.ts";

/**
 * テスト用の決定論的な系列生成。
 *
 * Math.random() を使うと落ちたときに再現できないテストになる。
 * 数理エンジンの検証は「同じ入力なら必ず同じ出力」が前提なので、
 * 乱数側も必ずシード固定にする。
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

/** 終値列から OHLCV バーを作る (高安は終値の ±0.5% に置く) */
export function bars(closes: number[], volume: number | null = 1_000_000): Bar[] {
  const day = 86400;
  return closes.map((c, i) => ({
    t: 1_600_000_000 + i * day,
    o: c,
    h: c * 1.005,
    l: c * 0.995,
    c,
    v: volume,
  }));
}

/** 実際の高安を指定できる版 */
export function ohlc(rows: [number, number, number, number][], volume = 1_000_000): Bar[] {
  const day = 86400;
  return rows.map(([o, h, l, c], i) => ({
    t: 1_600_000_000 + i * day,
    o, h, l, c,
    v: volume,
  }));
}

/** 一定率で伸びる終値列 */
export function trending(n: number, start = 100, dailyRate = 0.001): number[] {
  const out: number[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c *= 1 + dailyRate;
  }
  return out;
}

/** ランダムウォーク (シード固定) */
export function walk(n: number, seed = 7, start = 100, vol = 0.012): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let c = start;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c *= 1 + (r() - 0.5) * 2 * vol;
  }
  return out;
}

/** 正弦波 (レンジ相場の再現用) */
export function sine(n: number, period = 40, amp = 0.08, start = 100): number[] {
  return Array.from({ length: n }, (_, i) => start * (1 + amp * Math.sin((2 * Math.PI * i) / period)));
}

/** Wilder の RSI 検証で広く使われる終値列 (33本) */
export const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
  46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];
