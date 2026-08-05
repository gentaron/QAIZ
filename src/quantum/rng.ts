/**
 * 決定論的擬似乱数 (mulberry32)。
 *
 * 量子計算のシミュレーションは「測定」で必ず乱数を使う。
 * Math.random() を使うと、優位性ベンチマークの結果が実行ごとに変わり、
 * 「速くなった/ならなかった」を検証できないテストになってしまう。
 * QVM の測定・古典モンテカルロ・焼きなましは全部この RNG を通す。
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 累積分布からのサンプリング (cdf は昇順・末尾が 1 付近であること) */
export function sampleFromCdf(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 確率ベクトル → 累積分布 */
export function toCdf(p: ArrayLike<number>): Float64Array {
  const cdf = new Float64Array(p.length);
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i];
    cdf[i] = acc;
  }
  if (acc > 0) for (let i = 0; i < cdf.length; i++) cdf[i] /= acc;
  cdf[cdf.length - 1] = 1;
  return cdf;
}
