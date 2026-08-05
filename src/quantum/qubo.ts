/**
 * QUBO (Quadratic Unconstrained Binary Optimization) と Ising 模型。
 *
 *   E(x) = offset + cᵀx + xᵀQx        x ∈ {0,1}ⁿ, Q は対称
 *
 * QUBO の最小化は NP困難 (MAX-CUT を含む) であり、
 * 量子アニーリング / QAOA が狙う代表的な問題クラス。
 * QAIZ ではこれが「基数制約付きセクターバスケット選択」の形で現れる。
 */

export interface Qubo {
  n: number;
  /** n×n 対称行列を行優先でフラット化 */
  Q: Float64Array;
  /** 線形項 */
  c: Float64Array;
  offset: number;
}

export function makeQubo(n: number): Qubo {
  return { n, Q: new Float64Array(n * n), c: new Float64Array(n), offset: 0 };
}

/** Q_ij に値を足す (対称に反映) */
export function addQuadratic(q: Qubo, i: number, j: number, v: number): void {
  if (i === j) {
    q.Q[i * q.n + i] += v;
    return;
  }
  q.Q[i * q.n + j] += v / 2;
  q.Q[j * q.n + i] += v / 2;
}

export function addLinear(q: Qubo, i: number, v: number): void {
  q.c[i] += v;
}

/** ビットマスク表現 (bit i = x_i) のエネルギー */
export function energyOfMask(q: Qubo, mask: number): number {
  const { n, Q, c } = q;
  let e = q.offset;
  for (let i = 0; i < n; i++) {
    if (!(mask & (1 << i))) continue;
    e += c[i] + Q[i * n + i];
    for (let j = i + 1; j < n; j++) {
      if (mask & (1 << j)) e += 2 * Q[i * n + j];
    }
  }
  return e;
}

export function maskToBits(mask: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (mask >> i) & 1);
}

export function popcount(mask: number): number {
  let m = mask - ((mask >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return (m * 0x01010101) >> 24;
}

/**
 * 全 2ⁿ 基底状態のエネルギーを O(n·2ⁿ) で構成する。
 * QAOA のコスト層 (対角ユニタリ) と厳密解法の両方がこれを使う。
 */
export function energyDiagonal(q: Qubo): Float64Array {
  const { n, Q, c } = q;
  const dim = 1 << n;
  const diag = new Float64Array(dim);
  diag[0] = q.offset;
  for (let b = 1; b < dim; b++) {
    const low = b & -b;
    const i = 31 - Math.clz32(low);
    const rest = b ^ low;
    let s = c[i] + Q[i * n + i];
    for (let m = rest; m !== 0; m &= m - 1) {
      const j = 31 - Math.clz32(m & -m);
      s += 2 * Q[i * n + j];
    }
    diag[b] = diag[rest] + s;
  }
  return diag;
}

export interface Ising {
  n: number;
  /** 縦磁場 h_i (z_i の係数) */
  h: Float64Array;
  /** 結合 J_ij (i<j のみ格納。行優先フラット) */
  J: Float64Array;
  constant: number;
}

/**
 * QUBO → Ising。x_i = (1 - z_i)/2 で写す。
 * QAOA のコスト層を RZ / RZZ に分解するために必要
 * (資源見積りと OpenQASM 出力がこれを使う)。
 */
export function quboToIsing(q: Qubo): Ising {
  const { n, Q, c } = q;
  const h = new Float64Array(n);
  const J = new Float64Array(n * n);
  let constant = q.offset;

  for (let i = 0; i < n; i++) {
    const d = c[i] + Q[i * n + i]; // x_i² = x_i を使って対角を線形項に畳む
    constant += d / 2;
    h[i] -= d / 2;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = 2 * Q[i * n + j]; // 非対角の実効係数 (i<j の一対分)
      if (a === 0) continue;
      constant += a / 4;
      h[i] -= a / 4;
      h[j] -= a / 4;
      J[i * n + j] = a / 4;
    }
  }
  return { n, h, J, constant };
}

/** Ising エネルギー (検証用): z_i = 1 - 2x_i */
export function isingEnergyOfMask(ising: Ising, mask: number): number {
  const { n, h, J } = ising;
  const z = (i: number) => ((mask >> i) & 1 ? -1 : 1);
  let e = ising.constant;
  for (let i = 0; i < n; i++) {
    e += h[i] * z(i);
    for (let j = i + 1; j < n; j++) e += J[i * n + j] * z(i) * z(j);
  }
  return e;
}
