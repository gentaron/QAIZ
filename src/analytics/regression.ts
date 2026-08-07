import { isNum, round } from "./stats.ts";

/**
 * 多変量最小二乗回帰。
 *
 * ファクター帰属には説明変数が 6 本 (市場・規模・バリュー・収益性・投資・
 * モメンタム) 必要で、既存の単回帰では足りない。ここでは正規方程式
 * (XᵀX)β = Xᵀy をガウス消去で解く。
 *
 * 説明変数が 7 本 (切片込み) なので、数値的により安定な QR 分解までは
 * 要らない。ただし多重共線性で XᵀX が特異に近くなることは実際に起きるので、
 * ピボットが極端に小さければ **解を返さず null** にする。
 * 適当な値を返すと、意味のない α に t 値が付いて出てしまう。
 */

export interface OlsResult {
  /** 切片。ファクター帰属では α にあたる */
  intercept: number;
  interceptT: number;
  /** 各説明変数の係数 */
  coefficients: number[];
  /** 各係数の t 値 */
  tStats: number[];
  /** 各係数の標準誤差 */
  stdErrors: number[];
  rSquared: number;
  adjustedRSquared: number;
  /** 残差の標準偏差 */
  residualStd: number;
  observations: number;
}

/** ガウス・ジョルダン法で逆行列を求める。特異なら null */
export function invert(a: number[][], eps = 1e-12): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);

  for (let col = 0; col < n; col++) {
    // 部分ピボット選択
    let best = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[best][col])) best = r;
    }
    if (Math.abs(m[best][col]) < eps) return null; // 特異
    if (best !== col) {
      const t = m[best];
      m[best] = m[col];
      m[col] = t;
    }
    const pivot = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

/**
 * y を X で回帰する (切片あり)。
 *
 * @param X 行が観測、列が説明変数
 * @param y 被説明変数
 */
export function ols(X: number[][], y: number[]): OlsResult | null {
  const n = Math.min(X.length, y.length);
  const k = X[0]?.length ?? 0;
  if (n === 0 || k === 0) return null;
  // 説明変数の数に対して観測が少なすぎる回帰は、当てはまりだけ良くなって
  // 何も言えない。最低でも 1 変数あたり 10 観測は要求する。
  if (n < (k + 1) * 10) return null;

  // 切片列を先頭に付ける
  const d = k + 1;
  const Xd: number[][] = [];
  const yv: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = X[i];
    if (row.length !== k || !row.every(isNum) || !isNum(y[i])) continue;
    Xd.push([1, ...row]);
    yv.push(y[i]);
  }
  const m = Xd.length;
  if (m < (k + 1) * 10) return null;

  // XᵀX と Xᵀy
  const xtx: number[][] = Array.from({ length: d }, () => new Array(d).fill(0));
  const xty: number[] = new Array(d).fill(0);
  for (let i = 0; i < m; i++) {
    for (let a = 0; a < d; a++) {
      xty[a] += Xd[i][a] * yv[i];
      for (let b = a; b < d; b++) xtx[a][b] += Xd[i][a] * Xd[i][b];
    }
  }
  for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];

  const inv = invert(xtx);
  if (!inv) return null;

  const beta = new Array(d).fill(0);
  for (let a = 0; a < d; a++) {
    let acc = 0;
    for (let b = 0; b < d; b++) acc += inv[a][b] * xty[b];
    beta[a] = acc;
  }

  // 残差と決定係数
  const meanY = yv.reduce((s, v) => s + v, 0) / m;
  let rss = 0;
  let tss = 0;
  for (let i = 0; i < m; i++) {
    let fit = 0;
    for (let a = 0; a < d; a++) fit += beta[a] * Xd[i][a];
    const e = yv[i] - fit;
    rss += e * e;
    tss += (yv[i] - meanY) * (yv[i] - meanY);
  }
  const df = m - d;
  if (df <= 0) return null;
  const s2 = rss / df;
  const residualStd = Math.sqrt(s2);

  const stdErrors = beta.map((_, a) => Math.sqrt(Math.max(0, s2 * inv[a][a])));
  const tStats = beta.map((b, a) => (stdErrors[a] > 1e-15 ? b / stdErrors[a] : 0));
  const r2 = tss > 1e-18 ? Math.max(0, 1 - rss / tss) : 0;
  const adj = 1 - (1 - r2) * ((m - 1) / df);

  return {
    intercept: beta[0],
    interceptT: tStats[0],
    coefficients: beta.slice(1),
    tStats: tStats.slice(1),
    stdErrors: stdErrors.slice(1),
    rSquared: r2,
    adjustedRSquared: adj,
    residualStd,
    observations: m,
  };
}

/**
 * t 値から両側 p 値のおおよその値を返す。
 *
 * 自由度が 100 を超える前提で正規近似する。ファクター帰属では
 * 観測が 250 日前後あるので誤差は無視できる。厳密な t 分布が必要な
 * 場面ではこの関数を使わないこと。
 */
export function approxPValue(t: number): number | null {
  if (!isNum(t)) return null;
  const z = Math.abs(t);
  // Abramowitz & Stegun 26.2.17 による標準正規の裾確率
  const p = 0.2316419;
  const b = [0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
  const tt = 1 / (1 + p * z);
  const poly = b[0] * tt + b[1] * tt ** 2 + b[2] * tt ** 3 + b[3] * tt ** 4 + b[4] * tt ** 5;
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const upper = pdf * poly;
  return round(Math.min(1, Math.max(0, 2 * upper)), 4);
}

/** 統計的に有意といえるか (両側 5%) */
export function isSignificant(t: number | null): boolean {
  return isNum(t) && Math.abs(t) >= 1.96;
}
