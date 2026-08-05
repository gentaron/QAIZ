import {
  classicalMonteCarlo,
  classicalSampleRequirement,
  runIqae,
  type IqaeResult,
} from "../quantum/iqae.ts";
import { tailProbabilityProblem } from "../quantum/stateprep.ts";

/**
 * 問題 #2: 選んだバスケットのテールリスク推定。
 *
 *   a = P[ 1日損失 ≥ VaR閾値 ]
 *
 * これは「確率分布に対する期待値/確率の推定」であり、量子振幅推定が
 * **漸近的な二次高速化を証明済み**の問題クラスにそのまま乗る:
 *
 *   古典モンテカルロ  Θ(1/ε²) サンプル   (中心極限定理/Hoeffding の壁)
 *   量子振幅推定      O(1/ε)  オラクル呼び出し
 *     — Brassard, Høyer, Mosca, Tapp (2002)
 *     — Montanaro, "Quantum speedup of Monte Carlo methods" (2015)
 *     — Woerner & Egger, "Quantum risk analysis", npj QI 5, 15 (2019)
 *
 * 実務的な意味: リスク計測は「精度を1桁上げるとサンプルが100倍」という
 * コスト構造をしていて、日中の再計算頻度が精度に直接縛られている。
 * 二次高速化はこの縛りを「10倍」に変える。QAIZ ではバスケット選択の直後に
 * この推定が必ず走るので、優位性の測定対象が毎時ライブデータで生成される。
 *
 * 【但し書き】QAIZ が測っているのは **オラクル呼び出し回数** であって
 * 壁時計時間ではない。シミュレータ上の壁時計は状態ベクトルの指数コストに
 * 支配されるので必ず古典に負ける。ハードウェアがそのまま引き継ぐ量は
 * クエリ計算量の側であり、台帳もそちらだけを優位性として記録する。
 */

export interface TailRiskInput {
  /** バスケットの日次リターン系列 */
  returns: number[];
  /** ヒストグラムのビン数 (2のべき乗に切り上げられる) */
  bins?: number;
  /** VaR の信頼水準 (0.95 なら下位 5% 分位を閾値にする) */
  confidence?: number;
  /** 目標精度 (確率の絶対誤差) */
  epsilon?: number;
  alpha?: number;
  shots?: number;
  seed?: number;
}

export interface TailRiskResult {
  /** VaR 閾値 (損失として正の値。0.02 なら 2% の下落) */
  varThreshold: number;
  /** 経験分布から直接数えたテール確率 (真値) */
  exactTailProbability: number;
  /** 条件付き期待損失 (CVaR / Expected Shortfall) */
  cvar: number;
  /** ヒストグラムのビン数と量子ビット数 */
  bins: number;
  qubits: number;
  quantum: {
    estimate: number;
    interval: [number, number];
    oracleCalls: number;
    rounds: number;
    converged: boolean;
    /** 実機に投げる場合の資源 */
    resources: { qubits: number; gates1q: number; gates2q: number; depth: number };
  };
  classical: {
    estimate: number;
    /** 同じ精度・信頼度を保証するのに必要なサンプル数 (Hoeffding) */
    requiredSamples: number;
  };
  /** 古典必要サンプル数 ÷ 量子オラクル呼び出し数 */
  queryAdvantage: number;
  epsilon: number;
}

/** リターン系列 → 等幅ヒストグラム (2のべき乗ビン) */
export function histogram(
  returns: number[],
  bins: number
): { centers: Float64Array; probs: Float64Array } {
  const k = Math.max(1, Math.ceil(Math.log2(Math.max(2, bins))));
  const m = 1 << k;
  const centers = new Float64Array(m);
  const probs = new Float64Array(m);
  if (returns.length === 0) return { centers, probs };

  let lo = Infinity;
  let hi = -Infinity;
  for (const r of returns) {
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  if (!(hi > lo)) {
    centers[0] = lo;
    probs[0] = 1;
    return { centers, probs };
  }
  const width = (hi - lo) / m;
  for (let i = 0; i < m; i++) centers[i] = lo + width * (i + 0.5);
  for (const r of returns) {
    const idx = Math.min(m - 1, Math.max(0, Math.floor((r - lo) / width)));
    probs[idx] += 1;
  }
  for (let i = 0; i < m; i++) probs[i] /= returns.length;
  return { centers, probs };
}

/** 経験分位点 (下側)。confidence=0.95 なら 5% 分位 */
export function empiricalVar(returns: number[], confidence: number): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const q = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((1 - confidence) * sorted.length))
  );
  return -sorted[q]; // 損失として正で返す
}

export function analyzeTailRisk(input: TailRiskInput): TailRiskResult {
  const confidence = input.confidence ?? 0.95;
  const epsilon = input.epsilon ?? 0.01;
  const alpha = input.alpha ?? 0.05;
  const bins = input.bins ?? 32;

  const varThreshold = empiricalVar(input.returns, confidence);
  const { centers, probs } = histogram(input.returns, bins);
  const m = centers.length;
  const k = Math.round(Math.log2(m));

  // 「損失」を昇順に並べるため符号反転 (リターン -0.03 → 損失 +0.03)
  const losses = new Float64Array(m);
  for (let i = 0; i < m; i++) losses[i] = -centers[i];

  const { problem, exactTail, binIndex } = tailProbabilityProblem(
    losses,
    probs,
    varThreshold
  );

  const iqae: IqaeResult = runIqae(problem, {
    epsilon,
    alpha,
    shots: input.shots ?? 100,
    seed: input.seed ?? 424242,
  });

  const requiredSamples = classicalSampleRequirement(epsilon, alpha);
  // 古典側も同じ分布から実際に引く (基準線を机上の式だけにしない)
  const mc = classicalMonteCarlo(
    sortedProbsFor(losses, probs),
    (bin) => bin >= binIndex,
    Math.min(requiredSamples, 200_000),
    input.seed ?? 424242
  );

  const resources = problem.A.estimate();

  return {
    varThreshold,
    exactTailProbability: exactTail,
    cvar: conditionalValueAtRisk(input.returns, confidence),
    bins: m,
    qubits: k + 1,
    quantum: {
      estimate: iqae.estimate,
      interval: iqae.interval,
      oracleCalls: iqae.oracleCalls,
      rounds: iqae.rounds.length,
      converged: iqae.converged,
      resources: {
        qubits: resources.qubits,
        gates1q: resources.gates1q,
        gates2q: resources.gates2q,
        depth: resources.depth,
      },
    },
    classical: { estimate: mc.estimate, requiredSamples },
    queryAdvantage:
      iqae.oracleCalls > 0 ? requiredSamples / iqae.oracleCalls : 0,
    epsilon,
  };
}

/** tailProbabilityProblem と同じ並べ替えを古典側にも適用する */
function sortedProbsFor(losses: Float64Array, probs: Float64Array): Float64Array {
  const m = losses.length;
  const order = Array.from({ length: m }, (_, i) => i).sort(
    (a, b) => losses[a] - losses[b]
  );
  const out = new Float64Array(m);
  for (let i = 0; i < m; i++) out[i] = probs[order[i]];
  return out;
}

/** 条件付き期待損失 (Expected Shortfall)。損失として正で返す */
export function conditionalValueAtRisk(
  returns: number[],
  confidence: number
): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor((1 - confidence) * sorted.length));
  let s = 0;
  for (let i = 0; i < cut; i++) s += sorted[i];
  return -(s / cut);
}
