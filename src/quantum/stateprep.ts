import { Circuit } from "./circuit.ts";

/**
 * 分布ロードと述語オラクル。
 *
 * 振幅推定でテールリスクを測るには、まず損益分布を量子状態に載せる:
 *
 *   |0⟩^k → Σ_j √p_j |j⟩         (振幅ロード)
 *   |j⟩|0⟩ → |j⟩|χ(j)⟩            (述語オラクル)
 *
 * これで A|0⟩ = √(1-a)|bad⟩|0⟩ + √a|good⟩|1⟩ となり、
 * a = P[χ] = テール確率 が振幅推定の対象になる。
 */

/**
 * 任意の離散分布 p (長さ 2^k) を振幅としてロードする回路。
 *
 * Möttönen らの一様制御 RY による厳密構成。上位ビットから順に、
 * 「そこまでの分岐で条件付けた確率質量の比」を回転角に変換していく。
 * ゲート数は 2^k - 1 個の多重制御 RY で、k が小さいうちは実機でも現実的。
 *
 * ビット順は StateVector と同じリトルエンディアン
 * (qubit k-1 が最上位ビット)。
 */
export function amplitudeLoadCircuit(
  probs: Float64Array,
  k: number,
  totalQubits = k
): Circuit {
  const dim = 1 << k;
  if (probs.length !== dim) {
    throw new RangeError(`probs length must be 2^k = ${dim}, got ${probs.length}`);
  }
  if (totalQubits < k) throw new RangeError("totalQubits must be >= k");
  const circuit = new Circuit(totalQubits);

  // level l で最上位から l ビット目 (= qubit k-1-l) を決める
  for (let l = 0; l < k; l++) {
    const target = k - 1 - l;
    const controls: number[] = [];
    for (let t = 0; t < l; t++) controls.push(k - 1 - t);

    for (let pre = 0; pre < 1 << l; pre++) {
      // prefix pre (上位 l ビット) に条件付けた確率質量
      const { total, zero } = branchMass(probs, k, l, pre);
      if (total <= 0) continue;
      const ratio = Math.min(1, Math.max(0, zero / total));
      const theta = 2 * Math.acos(Math.sqrt(ratio));
      if (Math.abs(theta) < 1e-15) continue;

      // 制御パターン pre に合わせて 0 の位置を X で反転
      const flips: number[] = [];
      for (let t = 0; t < l; t++) {
        const bit = (pre >> (l - 1 - t)) & 1; // pre の上位から t 番目
        if (bit === 0) flips.push(k - 1 - t);
      }
      for (const q of flips) circuit.gate("x", q);
      circuit.cgate("ry", controls, target, [theta]);
      for (const q of flips) circuit.gate("x", q);
    }
  }
  return circuit;
}

/** prefix pre (上位 l ビット) 配下の質量と、その中で次ビットが 0 の質量 */
function branchMass(
  probs: Float64Array,
  k: number,
  l: number,
  pre: number
): { total: number; zero: number } {
  const suffixBits = k - l;
  const base = pre << suffixBits;
  const size = 1 << suffixBits;
  let total = 0;
  let zero = 0;
  for (let s = 0; s < size; s++) {
    const p = probs[base + s];
    total += p;
    // 次ビット (最上位から l+1 番目) が 0 = suffix の最上位ビットが 0
    if (suffixBits > 0 && (s >> (suffixBits - 1)) === 0) zero += p;
  }
  return { total, zero };
}

/**
 * 「インデックスが閾値以上か」を補助ビットに書き込むオラクル。
 *
 * 損失を昇順に並べたビンに対して χ(j) = [j ≥ j₀] を実装する。
 * シミュレータでは基底状態の入れ替えとして O(2ⁿ) で直接実行し、
 * 実機向けの資源は k ビット比較器の標準構成から見積もる。
 */
export function thresholdOracle(
  n: number,
  indexQubits: number,
  ancilla: number,
  j0: number
): Circuit {
  const circuit = new Circuit(n);
  const mask = (1 << indexQubits) - 1;
  const ancBit = 1 << ancilla;
  circuit.opaque({
    name: `cmp(index>=${j0})`,
    qubits: [...Array.from({ length: indexQubits }, (_, i) => i), ancilla],
    selfInverse: true,
    apply: (sv) => {
      // χ(j)=1 の基底状態について ancilla を反転 = 振幅の入れ替え
      for (let b = 0; b < sv.dim; b++) {
        if (b & ancBit) continue;
        if ((b & mask) < j0) continue;
        const b1 = b | ancBit;
        let t = sv.re[b]; sv.re[b] = sv.re[b1]; sv.re[b1] = t;
        t = sv.im[b]; sv.im[b] = sv.im[b1]; sv.im[b1] = t;
      }
    },
    estimate: {
      // 定数との比較は リップル型比較器で Toffoli ~k 個 + CNOT ~2k 個。
      // Toffoli = 6 CX 換算。補助ビットは k-1 本必要 (ここでは計上のみ)。
      gates1q: 2 * indexQubits,
      gates2q: 6 * indexQubits + 2 * indexQubits,
      depth: 8 * indexQubits,
    },
    note:
      `${indexQubits}ビット定数比較器 (リップル型, Toffoli≈${indexQubits}個)。` +
      `補助ビット ${Math.max(0, indexQubits - 1)} 本が別途必要で、` +
      `この見積りは文献ベースの概算 (実機トランスパイル結果ではない)。`,
  });
  return circuit;
}

/**
 * 振幅推定にかける問題インスタンス。
 * A|0…0⟩ = √(1-a)|ψ_bad⟩|0⟩ + √a|ψ_good⟩|1⟩ を満たす A と good ビットの組。
 */
export interface AmplitudeProblem {
  n: number;
  objectiveQubit: number;
  A: Circuit;
}

/**
 * 離散分布のテール確率 P[loss ≥ threshold] を振幅推定問題に変換する。
 * losses は昇順でなくてよい (内部で昇順に並べ替えてから閾値をビン境界に落とす)。
 */
export function tailProbabilityProblem(
  losses: Float64Array,
  probs: Float64Array,
  threshold: number
): { problem: AmplitudeProblem; exactTail: number; binIndex: number } {
  const m = losses.length;
  if (probs.length !== m) throw new RangeError("losses/probs length mismatch");
  const k = Math.ceil(Math.log2(m));
  const dim = 1 << k;

  const order = Array.from({ length: m }, (_, i) => i).sort(
    (a, b) => losses[a] - losses[b]
  );
  const sortedLoss = new Float64Array(dim);
  const sortedProb = new Float64Array(dim);
  for (let i = 0; i < m; i++) {
    sortedLoss[i] = losses[order[i]];
    sortedProb[i] = probs[order[i]];
  }
  // 2^k に満たない分はパディング (損失 +∞ 側に置くと閾値判定が壊れるので
  // 最大損失と同じ値・確率 0 で埋める)
  for (let i = m; i < dim; i++) {
    sortedLoss[i] = sortedLoss[m - 1];
    sortedProb[i] = 0;
  }

  let j0 = dim;
  for (let i = 0; i < dim; i++) {
    if (sortedLoss[i] >= threshold) {
      j0 = i;
      break;
    }
  }
  let exactTail = 0;
  for (let i = j0; i < dim; i++) exactTail += sortedProb[i];

  const n = k + 1;
  const ancilla = k;
  const A = amplitudeLoadCircuit(sortedProb, k, n);
  A.append(thresholdOracle(n, k, ancilla, j0));

  return {
    problem: { n, objectiveQubit: ancilla, A },
    exactTail,
    binIndex: j0,
  };
}
