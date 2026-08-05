import {
  addLinear,
  addQuadratic,
  energyOfMask,
  makeQubo,
  popcount,
  type Qubo,
} from "../quantum/qubo.ts";

/**
 * 問題 #1: 基数制約付きセクターバスケット選択 (CCSB)。
 *
 *   maximize   μᵀx − λ xᵀΣx
 *   subject to |x| = K,  x ∈ {0,1}ⁿ
 *
 * μ はセクターの期待魅力度 (既存のヒートスコア)、Σ は実現相関から作った
 * 共分散、K は「実際に何本買うか」。
 *
 * これは **基数制約付き平均分散最適化** で NP困難 (二次ナップサック / k-densest
 * subgraph を含む)。連続緩和と違って丸めでは最適解に届かないため、
 * 実務では厳密解が要る規模を超えた瞬間にヒューリスティクスへ落ちる。
 * 量子アニーリング / QAOA が最初に狙った問題クラスそのものであり、
 * QAIZ が「量子を挿す意味のある場所」として第一に据えるのはここ。
 *
 * 【正直な現状認識】
 * n = 16 セクターなら全探索 65,536 通りで厳密解が一瞬で出る。
 * この規模に量子的優位は **無い**。QAIZ はそれを隠さず、
 * 厳密解を必ず並走させて近似比を台帳に記録する (src/os/ledger.ts)。
 * 優位が生まれるのは n が数百に伸びたとき — 個別銘柄まで広げた場合であり、
 * その日に備えて問題の形と配管を先に用意しておく、というのがこの層の役割。
 */

export interface BasketInput {
  /** 各資産の識別子 */
  ids: string[];
  /** 期待魅力度 (ヒートスコアを [0,1] に正規化したもの) */
  mu: Float64Array;
  /** n×n 共分散 (行優先) */
  sigma: Float64Array;
  /** 選択本数 */
  cardinality: number;
  /** リスク回避係数 */
  riskAversion: number;
  /** 基数制約のペナルティ強度 (未指定なら自動決定) */
  penalty?: number;
}

export interface BasketSolution {
  mask: number;
  selected: string[];
  /** 制約を満たしているか */
  feasible: boolean;
  /** QUBO エネルギー (小さいほど良い) */
  energy: number;
  /** 制約項を除いた本来の目的関数値 (大きいほど良い) */
  objective: number;
  expectedReturn: number;
  variance: number;
}

/**
 * 基数制約をペナルティで埋め込んで QUBO 化する。
 *
 *   E(x) = −μᵀx + λ xᵀΣx + P (Σx_i − K)²
 *
 * P は「1 資産入れ替えても制約破りが得にならない」大きさが必要で、
 * 目的関数の最大変動幅より大きく取れば十分 (下限を自動計算する)。
 */
export function buildBasketQubo(input: BasketInput): Qubo {
  const n = input.ids.length;
  if (input.mu.length !== n) throw new RangeError("mu length mismatch");
  if (input.sigma.length !== n * n) throw new RangeError("sigma must be n×n");
  const K = input.cardinality;
  if (K < 1 || K > n) throw new RangeError("cardinality out of range");

  const lambda = input.riskAversion;
  const q = makeQubo(n);

  for (let i = 0; i < n; i++) {
    addLinear(q, i, -input.mu[i]);
    addQuadratic(q, i, i, lambda * input.sigma[i * n + i]);
    for (let j = i + 1; j < n; j++) {
      addQuadratic(q, i, j, 2 * lambda * input.sigma[i * n + j]);
    }
  }

  const P = input.penalty ?? autoPenalty(input, lambda);
  // P(Σx − K)² = P(Σx_i + 2Σ_{i<j}x_i x_j − 2KΣx_i + K²)
  for (let i = 0; i < n; i++) {
    addQuadratic(q, i, i, P);
    addLinear(q, i, -2 * P * K);
    for (let j = i + 1; j < n; j++) addQuadratic(q, i, j, 2 * P);
  }
  q.offset += P * K * K;

  return q;
}

/**
 * ペナルティ下限: 1 資産の出し入れで目的関数が動きうる最大幅。
 * これを超えていれば、制約違反が「得」になることはない。
 */
function autoPenalty(input: BasketInput, lambda: number): number {
  const n = input.ids.length;
  let maxSwing = 0;
  for (let i = 0; i < n; i++) {
    let s = Math.abs(input.mu[i]) + lambda * Math.abs(input.sigma[i * n + i]);
    for (let j = 0; j < n; j++) {
      if (i !== j) s += 2 * lambda * Math.abs(input.sigma[i * n + j]);
    }
    maxSwing = Math.max(maxSwing, s);
  }
  return Math.max(1e-6, maxSwing * 1.5);
}

/** ビットマスクを解として解釈する */
export function describeSolution(
  input: BasketInput,
  qubo: Qubo,
  mask: number
): BasketSolution {
  const n = input.ids.length;
  const selected: string[] = [];
  let expectedReturn = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    if (!(mask & (1 << i))) continue;
    selected.push(input.ids[i]);
    expectedReturn += input.mu[i];
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) variance += input.sigma[i * n + j];
    }
  }
  return {
    mask,
    selected,
    feasible: popcount(mask) === input.cardinality,
    energy: energyOfMask(qubo, mask),
    objective: expectedReturn - input.riskAversion * variance,
    expectedReturn,
    variance,
  };
}

/**
 * 標本共分散 (対角は分散)。リターン行列は [asset][time]。
 * 系列長が資産数より短いと特異になるので、対角に小さなリッジを足す。
 */
export function covarianceMatrix(
  returns: number[][],
  ridge = 1e-6
): Float64Array {
  const n = returns.length;
  const cov = new Float64Array(n * n);
  if (n === 0) return cov;
  const T = Math.min(...returns.map((r) => r.length));
  if (T < 2) return cov;

  const means = returns.map((r) => {
    let s = 0;
    for (let t = 0; t < T; t++) s += r[t];
    return s / T;
  });

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        s += (returns[i][t] - means[i]) * (returns[j][t] - means[j]);
      }
      const v = s / (T - 1);
      cov[i * n + j] = v;
      cov[j * n + i] = v;
    }
    cov[i * n + i] += ridge;
  }
  return cov;
}

/**
 * 選択されたバスケットの等加重ポートフォリオ・リターン系列。
 * テールリスク推定 (問題 #2) の入力になる。
 */
export function basketReturns(returns: number[][], mask: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < returns.length; i++) if (mask & (1 << i)) idx.push(i);
  if (idx.length === 0) return [];
  const T = Math.min(...idx.map((i) => returns[i].length));
  const out: number[] = new Array(T);
  for (let t = 0; t < T; t++) {
    let s = 0;
    // 末尾を揃える (系列長が違うとき、直近側で合わせるのが自然)
    for (const i of idx) s += returns[i][returns[i].length - T + t];
    out[t] = s / idx.length;
  }
  return out;
}
