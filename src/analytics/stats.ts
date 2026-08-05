/**
 * 統計プリミティブ。
 *
 * ここから上のレイヤーは全部この 1 枚に依存するので、
 *  - 欠損 (null / NaN / Infinity) は入口で必ず落とす
 *  - サンプル数が足りないときは 0 ではなく null を返す
 * の 2 点だけは徹底する。「データが無い」を「値が 0」に潰すと、
 * ランキングの上位に欠損銘柄が並ぶという典型的な事故が起きる。
 */

export type Num = number | null | undefined;

/** 有限な数値か。unknown を受けるのは、API から来た値をそのまま判定するため */
export function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** 有限値だけを取り出す */
export function clean(xs: Num[]): number[] {
  const out: number[] = [];
  for (const x of xs) if (isNum(x)) out.push(x);
  return out;
}

export function safeDiv(a: Num, b: Num): number | null {
  if (!isNum(a) || !isNum(b) || b === 0) return null;
  const r = a / b;
  return Number.isFinite(r) ? r : null;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : sum(xs) / xs.length;
}

/** 標本分散 (n-1)。n < 2 は null */
export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = sum(xs) / xs.length;
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return acc / (xs.length - 1);
}

export function stdev(xs: number[]): number | null {
  const v = variance(xs);
  return v === null ? null : Math.sqrt(v);
}

export function median(xs: number[]): number | null {
  return quantile(xs, 0.5);
}

/**
 * 分位点 (線形補間, R type-7)。
 * ソート済みでない配列を渡してよい (内部でコピーしてソートする)。
 */
export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

/** 中央絶対偏差。外れ値に強い散らばりの尺度 */
export function mad(xs: number[]): number | null {
  const m = median(xs);
  if (m === null) return null;
  return median(xs.map((x) => Math.abs(x - m)));
}

export function minOf(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => (b < a ? b : a));
}

export function maxOf(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => (b > a ? b : a));
}

/**
 * 分位点でのウィンザライズ。
 * バリュエーション指標は極端値 (PER 4000 倍など) が普通に出るので、
 * Zスコアを取る前に必ず通す。1 銘柄の外れ値でセクター全体の順位が
 * ひっくり返るのを防ぐ。
 */
export function winsorize(xs: number[], p = 0.05): number[] {
  if (xs.length < 4) return [...xs];
  const lo = quantile(xs, p);
  const hi = quantile(xs, 1 - p);
  if (lo === null || hi === null) return [...xs];
  return xs.map((x) => clamp(x, lo, hi));
}

/**
 * クロスセクションのZスコア。
 * 欠損は null のまま残す (0 で埋めると「平均的な銘柄」として扱われてしまう)。
 */
export function zscores(xs: Num[], opts: { winsorizeAt?: number; robust?: boolean } = {}): (number | null)[] {
  const idx: number[] = [];
  const vals: number[] = [];
  xs.forEach((x, i) => {
    if (isNum(x)) {
      idx.push(i);
      vals.push(x);
    }
  });
  const out: (number | null)[] = xs.map(() => null);
  if (vals.length < 3) return out;

  const w = opts.winsorizeAt ? winsorize(vals, opts.winsorizeAt) : vals;
  let center: number | null;
  let scale: number | null;
  if (opts.robust) {
    center = median(w);
    const m = mad(w);
    // 正規分布で σ に一致するようスケールを合わせる
    scale = m === null ? null : m * 1.4826;
  } else {
    center = mean(w);
    scale = stdev(w);
  }
  if (center === null || scale === null || scale < 1e-12) return out;

  w.forEach((v, k) => {
    out[idx[k]] = (v - center) / scale;
  });
  return out;
}

/** パーセンタイル順位 [0,100]。同値は平均順位 */
export function percentileRanks(xs: Num[]): (number | null)[] {
  const pairs: { i: number; v: number }[] = [];
  xs.forEach((x, i) => {
    if (isNum(x)) pairs.push({ i, v: x });
  });
  const out: (number | null)[] = xs.map(() => null);
  const n = pairs.length;
  if (n === 0) return out;
  if (n === 1) {
    out[pairs[0].i] = 50;
    return out;
  }
  pairs.sort((a, b) => a.v - b.v);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && pairs[j + 1].v === pairs[k].v) j++;
    // k..j が同値。その平均順位を配る
    const avgRank = (k + j) / 2;
    const pct = (avgRank / (n - 1)) * 100;
    for (let t = k; t <= j; t++) out[pairs[t].i] = pct;
    k = j + 1;
  }
  return out;
}

/** ピアソン相関 */
export function correlation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = sum(x) / n;
  const my = sum(y) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-18 || syy < 1e-18) return null;
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
}

export function covariance(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(a.length - n);
  const y = b.slice(b.length - n);
  const mx = sum(x) / n;
  const my = sum(y) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - 1);
}

/** 単回帰 y = alpha + beta x */
export function linreg(
  x: number[],
  y: number[]
): { alpha: number; beta: number; r2: number; residualStd: number } | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const xs = x.slice(x.length - n);
  const ys = y.slice(y.length - n);
  const mx = sum(xs) / n;
  const my = sum(ys) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-18) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const r2 = syy < 1e-18 ? 0 : clamp((sxy * sxy) / (sxx * syy), 0, 1);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = ys[i] - (alpha + beta * xs[i]);
    ss += e * e;
  }
  return { alpha, beta, r2, residualStd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

/** 歪度 (標本, フィッシャー) */
export function skewness(xs: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const m = sum(xs) / n;
  const s = stdev(xs);
  if (s === null || s < 1e-12) return null;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 3;
  return (n / ((n - 1) * (n - 2))) * acc;
}

/** 超過尖度 (標本) */
export function kurtosis(xs: number[]): number | null {
  const n = xs.length;
  if (n < 4) return null;
  const m = sum(xs) / n;
  const s = stdev(xs);
  if (s === null || s < 1e-12) return null;
  let acc = 0;
  for (const x of xs) acc += ((x - m) / s) ** 4;
  const g2 =
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * acc -
    (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return g2;
}

/** 指数加重移動平均の系列 */
export function ewmaSeries(xs: number[], span: number): number[] {
  if (xs.length === 0) return [];
  const alpha = 2 / (span + 1);
  const out: number[] = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    out.push(alpha * xs[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

/** 単純移動平均の系列。窓に満たない先頭は null */
export function smaSeries(xs: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (window <= 0 || xs.length < window) return out;
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    acc += xs[i];
    if (i >= window) acc -= xs[i - window];
    if (i >= window - 1) out[i] = acc / window;
  }
  return out;
}

/**
 * Zスコアを 0-100 のスコアに写す。
 * ±2.5σ で飽和させる。線形にすると外れ値でスコアが 0 / 100 に張り付き、
 * 中間層の差が消えてしまう。
 */
export function zToScore(z: number | null): number | null {
  if (!isNum(z)) return null;
  return Math.round(clamp(50 + (z / 2.5) * 50, 0, 100) * 10) / 10;
}

/** 加重平均。ウェイトが付いた要素のうち値が null のものは無視して再正規化する */
export function weightedMean(
  items: { value: number | null; weight: number }[]
): { value: number | null; usedWeight: number } {
  let acc = 0;
  let w = 0;
  for (const it of items) {
    if (isNum(it.value) && it.weight > 0) {
      acc += it.value * it.weight;
      w += it.weight;
    }
  }
  return { value: w > 0 ? acc / w : null, usedWeight: w };
}

/** 小数を指定桁で丸める (JSON を人間が読めるサイズに保つため) */
export function round(x: number | null, digits = 4): number | null {
  if (!isNum(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
