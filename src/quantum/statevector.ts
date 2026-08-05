import type { Mat2 } from "./gates.ts";
import { sampleFromCdf, toCdf, type Rng } from "./rng.ts";

/**
 * 状態ベクトル型 量子仮想マシン (QVM)。
 *
 * n 量子ビットの純粋状態 |ψ⟩ ∈ ℂ^{2^n} を実部/虚部の Float64Array 2本で保持する。
 * 依存ゼロ・Cloudflare Workers 上でそのまま動くことを最優先にした実装。
 *
 * ビット順は **リトルエンディアン**: 量子ビット q は基底インデックス b の bit q。
 * つまり |q_{n-1} ... q_1 q_0⟩ で b = Σ q_i 2^i。
 *
 * 【重要な但し書き】
 * これは古典計算機上の *シミュレータ* であり、実行時間は 2^n に比例する。
 * したがって「QVM で速く解けた」ことは量子優位性の証明にはならない。
 * QAIZ が優位性として計上するのは、ハードウェアがそのまま引き継ぐ量である
 * **オラクル呼び出し回数 / 回路リソース** だけ (src/os/ledger.ts 参照)。
 */
export class StateVector {
  readonly n: number;
  readonly dim: number;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`qubit count must be a positive integer, got ${n}`);
    }
    // 2^24 complex = 256MB。Worker のメモリ上限 (128MB) を守るため 22 で止める。
    if (n > 22) {
      throw new RangeError(
        `statevector simulation is capped at 22 qubits (requested ${n})`
      );
    }
    this.n = n;
    this.dim = 1 << n;
    this.re = new Float64Array(this.dim);
    this.im = new Float64Array(this.dim);
    this.re[0] = 1;
  }

  /** |0...0⟩ に戻す */
  reset(): void {
    this.re.fill(0);
    this.im.fill(0);
    this.re[0] = 1;
  }

  clone(): StateVector {
    const sv = new StateVector(this.n);
    sv.re.set(this.re);
    sv.im.set(this.im);
    return sv;
  }

  /** 1量子ビットゲートの適用 */
  applyGate(target: number, m: Mat2): void {
    this.assertQubit(target);
    const stride = 1 << target;
    const { re, im, dim } = this;
    const [r00, i00, r01, i01, r10, i10, r11, i11] = m;
    for (let b = 0; b < dim; b++) {
      if (b & stride) continue;
      const b1 = b | stride;
      const a0r = re[b], a0i = im[b];
      const a1r = re[b1], a1i = im[b1];
      re[b] = r00 * a0r - i00 * a0i + r01 * a1r - i01 * a1i;
      im[b] = r00 * a0i + i00 * a0r + r01 * a1i + i01 * a1r;
      re[b1] = r10 * a0r - i10 * a0i + r11 * a1r - i11 * a1i;
      im[b1] = r10 * a0i + i10 * a0r + r11 * a1i + i11 * a1r;
    }
  }

  /** 制御付き 1量子ビットゲート (制御は全て |1⟩ で発火) */
  applyControlledGate(controls: number[], target: number, m: Mat2): void {
    if (controls.length === 0) return this.applyGate(target, m);
    this.assertQubit(target);
    let mask = 0;
    for (const c of controls) {
      this.assertQubit(c);
      if (c === target) throw new Error("control qubit must differ from target");
      mask |= 1 << c;
    }
    const stride = 1 << target;
    const { re, im, dim } = this;
    const [r00, i00, r01, i01, r10, i10, r11, i11] = m;
    for (let b = 0; b < dim; b++) {
      if (b & stride) continue;
      if ((b & mask) !== mask) continue;
      const b1 = b | stride;
      const a0r = re[b], a0i = im[b];
      const a1r = re[b1], a1i = im[b1];
      re[b] = r00 * a0r - i00 * a0i + r01 * a1r - i01 * a1i;
      im[b] = r00 * a0i + i00 * a0r + r01 * a1i + i01 * a1r;
      re[b1] = r10 * a0r - i10 * a0i + r11 * a1r - i11 * a1i;
      im[b1] = r10 * a0i + i10 * a0r + r11 * a1i + i11 * a1r;
    }
  }

  /**
   * 対角ユニタリ exp(-i θ_b) の一括適用。
   *
   * QAOA のコスト層はハミルトニアンが対角なので、本来 O(n²) 個の RZ/RZZ に
   * 分解されるところを O(2^n) の位相掛けで融合できる。
   * 分解後のゲート数は Circuit 側で別途カウントし、資源見積りの正確さを保つ。
   */
  applyDiagonalPhase(theta: Float64Array): void {
    if (theta.length !== this.dim) {
      throw new RangeError("diagonal phase length must equal 2^n");
    }
    const { re, im, dim } = this;
    for (let b = 0; b < dim; b++) {
      const c = Math.cos(theta[b]);
      const s = Math.sin(theta[b]);
      const r = re[b], i = im[b];
      re[b] = r * c + i * s;   // (r + i·i) · e^{-iθ}
      im[b] = i * c - r * s;
    }
  }

  /** 選択された基底状態の振幅の符号を反転する (位相オラクル) */
  applyPhaseFlip(predicate: (basis: number) => boolean): void {
    const { re, im, dim } = this;
    for (let b = 0; b < dim; b++) {
      if (predicate(b)) {
        re[b] = -re[b];
        im[b] = -im[b];
      }
    }
  }

  /** S_0 = I - 2|0…0⟩⟨0…0| : |0…0⟩ だけ符号反転 (Grover の拡散に使う) */
  reflectAboutZero(): void {
    this.re[0] = -this.re[0];
    this.im[0] = -this.im[0];
  }

  /** 全体の符号反転 (グローバル位相。Grover 演算子の規約合わせ用) */
  negate(): void {
    const { re, im, dim } = this;
    for (let b = 0; b < dim; b++) {
      re[b] = -re[b];
      im[b] = -im[b];
    }
  }

  /** 各基底状態の確率 |amp|² */
  probabilities(): Float64Array {
    const p = new Float64Array(this.dim);
    for (let b = 0; b < this.dim; b++) {
      p[b] = this.re[b] * this.re[b] + this.im[b] * this.im[b];
    }
    return p;
  }

  /** 量子ビット q が value である確率 (周辺化) */
  marginal(q: number, value: 0 | 1): number {
    this.assertQubit(q);
    const stride = 1 << q;
    let acc = 0;
    for (let b = 0; b < this.dim; b++) {
      if (((b & stride) !== 0 ? 1 : 0) !== value) continue;
      acc += this.re[b] * this.re[b] + this.im[b] * this.im[b];
    }
    return acc;
  }

  /** ノルム (数値誤差の検査用) */
  norm(): number {
    let acc = 0;
    for (let b = 0; b < this.dim; b++) {
      acc += this.re[b] * this.re[b] + this.im[b] * this.im[b];
    }
    return Math.sqrt(acc);
  }

  /**
   * 全量子ビットを計算基底で測定した shot 列。
   * 実機と同じく「確率分布からのサンプル」であり、期待値そのものではない。
   */
  sample(shots: number, rng: Rng): Int32Array {
    const cdf = toCdf(this.probabilities());
    const counts = new Int32Array(this.dim);
    for (let s = 0; s < shots; s++) counts[sampleFromCdf(cdf, rng())]++;
    return counts;
  }

  /** 特定の量子ビットだけを測定した 1 の観測回数 (実機の典型的な読み出し) */
  sampleQubit(q: number, shots: number, rng: Rng): number {
    const p1 = this.marginal(q, 1);
    let ones = 0;
    for (let s = 0; s < shots; s++) if (rng() < p1) ones++;
    return ones;
  }

  private assertQubit(q: number): void {
    if (!Number.isInteger(q) || q < 0 || q >= this.n) {
      throw new RangeError(`qubit index out of range: ${q} (n=${this.n})`);
    }
  }
}
