import { Circuit } from "./circuit.ts";
import { mulberry32, type Rng } from "./rng.ts";
import { StateVector } from "./statevector.ts";
import type { AmplitudeProblem } from "./stateprep.ts";

/**
 * Iterative Quantum Amplitude Estimation (IQAE)。
 *
 * 「A|0⟩ の good 状態の振幅 a を推定する」問題は、量子計算で
 * **証明済みの二次高速化**が得られる数少ない実用問題である:
 *
 *   古典モンテカルロ  … 誤差 ε に対して Θ(1/ε²) 回のサンプル
 *   量子振幅推定      … 誤差 ε に対して O(1/ε) 回のオラクル呼び出し
 *                        (Brassard-Høyer-Mosca-Tapp 2002)
 *
 * 教科書的な QAE は位相推定レジスタを積むので量子ビットを大量に食うが、
 * IQAE (Grinko-Gacon-Zoufal-Woerner 2021) は追加の量子ビットなしで
 * 同じ O(1/ε) を達成する。NISQ 機で唯一現実味のある構成なのでこれを採る。
 *
 * ---
 * 【実装の考え方】
 * Grover 演算子 Q = A S₀ A† S_χ を k 回かけた状態で good ビットを測ると
 *
 *   p_k = sin²((2k+1)θ),   a = sin²θ,  θ ∈ [0, π/2]
 *
 * が成り立つ。m = 2k+1 を「[m·θ_lo, m·θ_hi] が sin² の単調区間
 * [jπ/2, (j+1)π/2] に収まる」最大の奇数に選べば、測定値 p̂ の信頼区間を
 * 一意に θ の区間へ逆写像できる。m は反復ごとに指数的に伸ばせるので、
 * 総オラクル呼び出し Σ N·m が O(1/ε) に収まる。
 */

export interface IqaeOptions {
  /** 目標精度 (振幅 a の絶対誤差) */
  epsilon: number;
  /** 有意水準。信頼度は 1-alpha */
  alpha?: number;
  /** 1 ラウンドあたりのショット数 */
  shots?: number;
  seed?: number;
  maxRounds?: number;
  /** Grover 演算子を明示的にシミュレートする上限 (安全弁) */
  maxGroverPower?: number;
}

export interface IqaeRound {
  k: number;
  m: number;
  shots: number;
  ones: number;
  /** 実測確率 */
  pHat: number;
  thetaLo: number;
  thetaHi: number;
}

export interface IqaeResult {
  estimate: number;
  interval: [number, number];
  rounds: IqaeRound[];
  /** Σ shots·(2k+1) — 実機がそのまま引き継ぐコスト指標 */
  oracleCalls: number;
  /** 到達した半区間幅 (振幅スケール) */
  epsilonAchieved: number;
  converged: boolean;
  /** シミュレータなので分かる真値 (検証専用。実機では取得できない) */
  exactAmplitude: number;
}

/** Grover 演算子 Q = A S₀ A† S_χ を状態に 1 回作用させる */
function applyGrover(
  sv: StateVector,
  A: Circuit,
  Ainv: Circuit,
  objectiveQubit: number
): void {
  const objMask = 1 << objectiveQubit;
  sv.applyPhaseFlip((b) => (b & objMask) !== 0); // S_χ
  Ainv.run(sv);
  sv.reflectAboutZero(); // S₀ = I - 2|0…0⟩⟨0…0|
  sv.negate(); // 全体位相 (測定確率には無影響。規約合わせ)
  A.run(sv);
}

/** k 回の Grover 適用後に good を観測する確率 */
export function groverProbability(
  problem: AmplitudeProblem,
  k: number
): number {
  const Ainv = problem.A.inverse();
  const sv = new StateVector(problem.n);
  problem.A.run(sv);
  for (let i = 0; i < k; i++) {
    applyGrover(sv, problem.A, Ainv, problem.objectiveQubit);
  }
  return sv.marginal(problem.objectiveQubit, 1);
}

/**
 * [m·lo, m·hi] が sin² の単調区間に収まる最大の奇数 m を探す。
 * 見つからなければ現在の m を据え置く (進捗はしないが正しさは壊れない)。
 */
export function findNextM(
  thetaLo: number,
  thetaHi: number,
  mPrev: number,
  searchLimit = 512
): { m: number; branch: number } | null {
  const width = thetaHi - thetaLo;
  if (!(width > 0)) return null;
  const HALF = Math.PI / 2;
  let mMax = Math.floor(HALF / width);
  if (mMax % 2 === 0) mMax -= 1;
  if (mMax < mPrev) mMax = mPrev;

  let tried = 0;
  for (let m = mMax; m >= mPrev && tried < searchLimit; m -= 2, tried++) {
    const jLo = Math.floor((m * thetaLo) / HALF);
    const jHi = Math.floor((m * thetaHi) / HALF);
    // 端点がちょうど境界に乗るケースを吸収
    if (jLo === jHi || (jHi === jLo + 1 && m * thetaHi - jHi * HALF < 1e-12)) {
      return { m, branch: jLo };
    }
  }
  return null;
}

/** Chernoff-Hoeffding 信頼区間の半幅 */
function hoeffdingHalfWidth(shots: number, alpha: number): number {
  return Math.sqrt(Math.log(2 / alpha) / (2 * shots));
}

/** p ∈ [0,1] と分岐 j から θ 区間へ逆写像する */
export function invertProbabilityInterval(
  pLo: number,
  pHi: number,
  m: number,
  branch: number
): [number, number] {
  const HALF = Math.PI / 2;
  const base = branch * HALF;
  const lo = Math.min(1, Math.max(0, pLo));
  const hi = Math.min(1, Math.max(0, pHi));
  let vLo: number;
  let vHi: number;
  if (branch % 2 === 0) {
    // sin² が増加する区間
    vLo = Math.asin(Math.sqrt(lo));
    vHi = Math.asin(Math.sqrt(hi));
  } else {
    // sin² が減少する区間: sin²(base+v) = cos²(v)
    vLo = Math.acos(Math.sqrt(hi));
    vHi = Math.acos(Math.sqrt(lo));
  }
  return [(base + vLo) / m, (base + vHi) / m];
}

export function runIqae(
  problem: AmplitudeProblem,
  opts: IqaeOptions
): IqaeResult {
  const epsilon = opts.epsilon;
  if (!(epsilon > 0 && epsilon < 0.5)) {
    throw new RangeError("epsilon must be in (0, 0.5)");
  }
  const alpha = opts.alpha ?? 0.05;
  const shots = opts.shots ?? 100;
  const maxRounds = opts.maxRounds ?? 60;
  const maxGroverPower = opts.maxGroverPower ?? 4096;
  const rng: Rng = mulberry32(opts.seed ?? 424242);

  const Ainv = problem.A.inverse();
  const base = new StateVector(problem.n);
  problem.A.run(base);
  const exactAmplitude = base.marginal(problem.objectiveQubit, 1);

  // ラウンド間で信頼度を分配 (Bonferroni)
  const alphaRound = alpha / maxRounds;
  const halfWidth = hoeffdingHalfWidth(shots, alphaRound);

  let thetaLo = 0;
  let thetaHi = Math.PI / 2;
  let mPrev = 1;
  let oracleCalls = 0;
  const rounds: IqaeRound[] = [];

  // Grover を適用した状態を使い回す (k を増やすたびに 1 回だけ追加適用)
  let sv = base.clone();
  let kCurrent = 0;

  for (let r = 0; r < maxRounds; r++) {
    if ((thetaHi - thetaLo) / 2 <= thetaTolerance(epsilon, thetaLo, thetaHi)) break;

    const next = findNextM(thetaLo, thetaHi, mPrev);
    if (!next) break;
    const { m, branch } = next;
    const k = (m - 1) / 2;
    if (k > maxGroverPower) break;

    if (k < kCurrent) {
      sv = base.clone();
      kCurrent = 0;
    }
    while (kCurrent < k) {
      applyGrover(sv, problem.A, Ainv, problem.objectiveQubit);
      kCurrent++;
    }

    const ones = sv.sampleQubit(problem.objectiveQubit, shots, rng);
    oracleCalls += shots * m;
    const pHat = ones / shots;

    const [lo, hi] = invertProbabilityInterval(
      pHat - halfWidth,
      pHat + halfWidth,
      m,
      branch
    );
    // 区間は必ず狭まる方向にのみ更新する (統計的外れで発散させない)
    const newLo = Math.max(thetaLo, Math.min(lo, thetaHi));
    const newHi = Math.min(thetaHi, Math.max(hi, thetaLo));
    if (newHi > newLo) {
      thetaLo = newLo;
      thetaHi = newHi;
    }
    mPrev = m;

    rounds.push({ k, m, shots, ones, pHat, thetaLo, thetaHi });
    if (mPrev >= 2 * maxGroverPower) break;
  }

  const aLo = Math.sin(thetaLo) ** 2;
  const aHi = Math.sin(thetaHi) ** 2;
  const estimate = Math.sin((thetaLo + thetaHi) / 2) ** 2;
  const epsilonAchieved = (aHi - aLo) / 2;

  return {
    estimate,
    interval: [aLo, aHi],
    rounds,
    oracleCalls,
    epsilonAchieved,
    converged: epsilonAchieved <= epsilon,
    exactAmplitude,
  };
}

/**
 * θ 区間から a 区間への変換で必要な θ 精度。
 * a = sin²θ より da/dθ = sin(2θ) ≤ 1 なので、区間内の最大傾きで割る。
 */
function thetaTolerance(epsilon: number, lo: number, hi: number): number {
  const slope = Math.max(
    Math.abs(Math.sin(2 * lo)),
    Math.abs(Math.sin(2 * hi)),
    lo <= Math.PI / 4 && hi >= Math.PI / 4 ? 1 : 0,
    1e-6
  );
  return epsilon / slope;
}

/**
 * 同じ精度を古典モンテカルロで達成するのに必要なサンプル数 (Hoeffding)。
 *   N ≥ ln(2/α) / (2ε²)
 * IQAE のオラクル呼び出し数と直接比較するための基準線。
 */
export function classicalSampleRequirement(epsilon: number, alpha = 0.05): number {
  return Math.ceil(Math.log(2 / alpha) / (2 * epsilon * epsilon));
}

/** 古典モンテカルロで実際に推定する (基準線の実測用) */
export function classicalMonteCarlo(
  probs: Float64Array,
  predicate: (bin: number) => boolean,
  samples: number,
  seed = 7
): { estimate: number; samples: number } {
  const rng = mulberry32(seed);
  const cdf = new Float64Array(probs.length);
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    cdf[i] = acc;
  }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= acc || 1;
  cdf[cdf.length - 1] = 1;

  let hits = 0;
  for (let s = 0; s < samples; s++) {
    const u = rng();
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    if (predicate(lo)) hits++;
  }
  return { estimate: hits / samples, samples };
}
