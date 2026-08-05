import { popcount } from "./qubo.ts";
import { sampleFromCdf, toCdf, type Rng } from "./rng.ts";

/**
 * ハミング重み保存セクタに限定した状態ベクトルシミュレータ。
 *
 * XY ミキサー exp(-iβ(X_iX_j + Y_iY_j)/2) と対角コストハミルトニアンは
 * どちらも粒子数 Σn_i を保存する。したがって Dicke 状態 |D^n_K⟩ から出発する
 * QAOA+ の状態は **重み K のセクタから決して出ない**。
 *
 * ならば 2ⁿ 次元を持ち歩く理由がない。C(n,K) 次元だけ回せばよい:
 *
 *   n=16, K=6 →  65,536 次元 が 8,008 次元 (8.2倍の削減)
 *   n=20, K=8 → 1,048,576 次元 が 125,970 次元 (8.3倍)
 *
 * 対称性でヒルベルト空間を切るのは量子シミュレーションの常道であり、
 * エッジの CPU 予算内で QAOA を回すにはこれが必須だった。
 * 完全な状態ベクトルとの一致はテストで固定している (test/quantum_sector.test.ts)。
 */
export class WeightSectorState {
  readonly n: number;
  readonly k: number;
  /** セクタ内の基底 (ビットマスク、昇順) */
  readonly masks: Int32Array;
  /** マスク → セクタ内位置 (セクタ外は -1) */
  readonly position: Int32Array;
  readonly dim: number;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(n: number, k: number, masks: Int32Array) {
    this.n = n;
    this.k = k;
    this.masks = masks;
    this.dim = masks.length;
    this.re = new Float64Array(this.dim);
    this.im = new Float64Array(this.dim);
    this.position = new Int32Array(1 << n).fill(-1);
    for (let d = 0; d < masks.length; d++) this.position[masks[d]] = d;
  }

  /** |D^n_K⟩: セクタ内一様重ね合わせ */
  prepareUniform(): void {
    const amp = this.dim > 0 ? 1 / Math.sqrt(this.dim) : 0;
    this.re.fill(amp);
    this.im.fill(0);
  }

  /** exp(-iγ E_d) をセクタ対角に適用 */
  applyDiagonalPhase(gamma: number, energies: Float64Array): void {
    const { re, im, dim } = this;
    for (let d = 0; d < dim; d++) {
      const t = gamma * energies[d];
      const c = Math.cos(t);
      const s = Math.sin(t);
      const r = re[d], i = im[d];
      re[d] = r * c + i * s;
      im[d] = i * c - r * s;
    }
  }

  /**
   * XY 相互作用をセクタ内で適用する。
   * transpositions は [pos01, pos10, pos01, pos10, ...] の並び
   * (buildXYTranspositions で事前に作る)。
   */
  applyXY(transpositions: Int32Array, beta: number): void {
    const c = Math.cos(beta);
    const s = Math.sin(beta);
    const { re, im } = this;
    for (let t = 0; t < transpositions.length; t += 2) {
      const a = transpositions[t];
      const b = transpositions[t + 1];
      const ar = re[a], ai = im[a];
      const br = re[b], bi = im[b];
      // [[c, -is], [-is, c]]
      re[a] = c * ar + s * bi;
      im[a] = c * ai - s * br;
      re[b] = c * br + s * ai;
      im[b] = c * bi - s * ar;
    }
  }

  probabilities(): Float64Array {
    const p = new Float64Array(this.dim);
    for (let d = 0; d < this.dim; d++) {
      p[d] = this.re[d] * this.re[d] + this.im[d] * this.im[d];
    }
    return p;
  }

  norm(): number {
    let acc = 0;
    for (let d = 0; d < this.dim; d++) {
      acc += this.re[d] * this.re[d] + this.im[d] * this.im[d];
    }
    return Math.sqrt(acc);
  }

  sample(shots: number, rng: Rng): Int32Array {
    const cdf = toCdf(this.probabilities());
    const counts = new Int32Array(this.dim);
    for (let s = 0; s < shots; s++) counts[sampleFromCdf(cdf, rng())]++;
    return counts;
  }
}

/** 重み k のビット列 (昇順、Gosper's hack) */
export function weightKMasks(n: number, k: number): Int32Array {
  if (k === 0) return Int32Array.of(0);
  if (k < 0 || k > n) return new Int32Array(0);
  const out: number[] = [];
  const limit = 1 << n;
  let mask = (1 << k) - 1;
  while (mask < limit) {
    out.push(mask);
    const c = mask & -mask;
    const r = mask + c;
    mask = (((r ^ mask) >>> 2) / c) | r;
  }
  return Int32Array.from(out);
}

/**
 * ペア (i,j) について、セクタ内で |0_i 1_j⟩ ↔ |1_i 0_j⟩ を結ぶ位置の組を作る。
 * XY 項はこの互換のみを回すので、事前計算しておけば適用は O(組数) で済む。
 */
export function buildXYTranspositions(
  state: WeightSectorState,
  i: number,
  j: number
): Int32Array {
  const bi = 1 << i;
  const bj = 1 << j;
  const out: number[] = [];
  for (let d = 0; d < state.dim; d++) {
    const m = state.masks[d];
    if ((m & bi) !== 0 || (m & bj) === 0) continue; // i=0, j=1 の側だけ代表に取る
    const partner = (m ^ bj) | bi;
    const pd = state.position[partner];
    if (pd >= 0) out.push(d, pd);
  }
  return Int32Array.from(out);
}

/** 全基底の対角エネルギーから、セクタ内だけを抜き出す */
export function sectorEnergies(
  masks: Int32Array,
  fullDiagonal: Float64Array
): Float64Array {
  const out = new Float64Array(masks.length);
  for (let d = 0; d < masks.length; d++) out[d] = fullDiagonal[masks[d]];
  return out;
}

export { popcount };
