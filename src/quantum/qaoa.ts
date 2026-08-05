import { Circuit, type GateInstr, type ResourceEstimate } from "./circuit.ts";
import { nelderMead } from "./optimizer.ts";
import {
  energyDiagonal,
  energyOfMask,
  popcount,
  quboToIsing,
  type Qubo,
} from "./qubo.ts";
import { mulberry32 } from "./rng.ts";
import {
  buildXYTranspositions,
  sectorEnergies,
  weightKMasks,
  WeightSectorState,
} from "./sector.ts";
import { StateVector } from "./statevector.ts";

/**
 * QAOA / QAOA+ (Quantum Alternating Operator Ansatz)。
 *
 *   |ψ(γ,β)⟩ = ∏_{l=1..p} e^{-iβ_l H_M} e^{-iγ_l H_C} · |init⟩
 *
 * H_C は QUBO のエネルギーを対角に持つコストハミルトニアン。
 * ミキサー H_M は 2 種類を実装している:
 *
 *  - **X ミキサー** (Farhi et al. 2014): H_M = Σ X_i、初期状態 H^{⊗n}|0⟩。
 *    制約はペナルティ項で表現する。全ゲートが標準ゲートなので
 *    OpenQASM3 に完全に書き出せる = 実機にそのまま投げられる。
 *
 *  - **XY リングミキサー** (Hadfield et al. 2019): H_M = Σ (X_iX_{i+1} + Y_iY_{i+1})/2。
 *    ハミング重みを保存するので、初期状態を Dicke 状態 |D^n_K⟩ にすれば
 *    **基数制約 |x|=K を満たす部分空間から一歩も出ない**。
 *    ペナルティ項が要らずコストランドスケープが素直になるぶん解が良い。
 *
 * 基数制約付き問題では XY が本命。ペナルティ方式は制約違反状態が
 * エネルギー空間の大半を占めてしまい、γ の有効レンジが潰れる
 * (実測でも X ミキサーは近似比が明確に落ちる)。
 *
 * 目的関数には期待値ではなく **CVaR_α** を使う。QAOA は「良い解を確率的に
 * 含む分布」を作る器であって平均を下げる器ではないため、浅い回路では
 * CVaR の方が圧倒的に速く良解へ寄る
 * (Barkoutsos et al., "Improving Variational Quantum Optimization using CVaR", 2020)。
 */

export type MixerKind = "x" | "xy";

export interface QaoaOptions {
  /** 層数 p */
  layers?: number;
  /** 最終的な解の読み出しショット数 (実機と同じく確率分布からのサンプル) */
  shots?: number;
  /** CVaR の分位 α ∈ (0,1]。1 なら通常の期待値最小化 */
  cvarAlpha?: number;
  seed?: number;
  maxEvals?: number;
  timeBudgetMs?: number;
  now?: () => number;
  mixer?: MixerKind;
  /** XY ミキサーで保存するハミング重み (= 基数制約 K) */
  cardinality?: number;
}

export interface QaoaResult {
  bestMask: number;
  /** 元の (正規化前) QUBO でのエネルギー */
  bestEnergy: number;
  /** 最適パラメータでの ⟨H_C⟩ (正規化スケール) */
  expectation: number;
  cvar: number;
  gamma: number[];
  beta: number[];
  evals: number;
  shots: number;
  mixer: MixerKind;
  /** 最良解が測定で当たる確率 */
  bestProbability: number;
  /** 制約部分空間の外に漏れた確率 (XY ミキサーなら理論上 0) */
  leakage: number;
  resources: ResourceEstimate & { notes: string[] };
  /** 実機投入用の回路 */
  circuit: Circuit;
}

/**
 * エネルギーを [0,1] に正規化した QUBO を作る。
 * 制約付きの場合は **実行可能解だけ** でレンジを取る — 実行不能状態まで
 * 含めると、ペナルティの巨大値がレンジを支配して γ の分解能が消える。
 */
export function normalizeQubo(
  q: Qubo,
  feasible?: (mask: number) => boolean
): { qubo: Qubo; scale: number; shift: number; diag: Float64Array } {
  const diag = energyDiagonal(q);
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = 0; b < diag.length; b++) {
    if (feasible && !feasible(b)) continue;
    if (diag[b] < lo) lo = diag[b];
    if (diag[b] > hi) hi = diag[b];
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const span = hi - lo;
  const scale = span > 1e-12 ? 1 / span : 1;
  const n = q.n;
  const out: Qubo = {
    n,
    Q: new Float64Array(n * n),
    c: new Float64Array(n),
    offset: (q.offset - lo) * scale,
  };
  for (let i = 0; i < n * n; i++) out.Q[i] = q.Q[i] * scale;
  for (let i = 0; i < n; i++) out.c[i] = q.c[i] * scale;
  // 正規化後の対角は元の対角のアフィン変換なので、作り直さず使い回す
  // (energyDiagonal は O(n·2ⁿ) で、エッジの CPU 予算では無視できない)
  for (let b = 0; b < diag.length; b++) diag[b] = (diag[b] - lo) * scale;
  return { qubo: out, scale, shift: lo, diag };
}

/** コスト層 exp(-iγ H_C) の RZ/RZZ 分解 (資源見積り・QASM 用) */
function costLayerGates(q: Qubo, gamma: number): GateInstr[] {
  const ising = quboToIsing(q);
  const gates: GateInstr[] = [];
  for (let i = 0; i < ising.n; i++) {
    if (ising.h[i] === 0) continue;
    gates.push({ kind: "gate", name: "rz", controls: [], target: i, params: [2 * gamma * ising.h[i]] });
  }
  for (let i = 0; i < ising.n; i++) {
    for (let j = i + 1; j < ising.n; j++) {
      const jij = ising.J[i * ising.n + j];
      if (jij === 0) continue;
      // RZZ(θ) = CX(i,j) · RZ(θ)_j · CX(i,j)
      gates.push({ kind: "gate", name: "x", controls: [i], target: j, params: [] });
      gates.push({ kind: "gate", name: "rz", controls: [], target: j, params: [2 * gamma * jij] });
      gates.push({ kind: "gate", name: "x", controls: [i], target: j, params: [] });
    }
  }
  return gates;
}

/**
 * XY 相互作用 exp(-iβ (X_iX_j + Y_iY_j)/2)。
 * {|01⟩, |10⟩} の 2 次元部分空間だけを回す (|00⟩,|11⟩ は不変)。
 */
export function applyXYPair(sv: StateVector, i: number, j: number, beta: number): void {
  const bi = 1 << i;
  const bj = 1 << j;
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  for (let b = 0; b < sv.dim; b++) {
    // |...0_i...1_j...⟩ を代表元として取る
    if ((b & bi) !== 0 || (b & bj) === 0) continue;
    const b01 = b;          // i=0, j=1
    const b10 = (b ^ bj) | bi; // i=1, j=0
    const ar = sv.re[b01], ai = sv.im[b01];
    const br = sv.re[b10], bi2 = sv.im[b10];
    // [[c, -is], [-is, c]]
    sv.re[b01] = c * ar + s * bi2;
    sv.im[b01] = c * ai - s * br;
    sv.re[b10] = c * br + s * ai;
    sv.im[b10] = c * bi2 - s * ar;
  }
}

/**
 * Dicke 状態 |D^n_K⟩ = 重み K の全ビット列の一様重ね合わせ。
 * 目的関数評価のたびに呼ばれるので、対象マスクは呼び出し側で使い回す。
 */
export function prepareDicke(sv: StateVector, k: number, masks?: Int32Array): void {
  sv.re.fill(0);
  sv.im.fill(0);
  const ms = masks ?? weightKMasks(sv.n, k);
  if (ms.length === 0) {
    sv.re[0] = 1;
    return;
  }
  const amp = 1 / Math.sqrt(ms.length);
  for (let i = 0; i < ms.length; i++) sv.re[ms[i]] = amp;
}

/** 回路 IR を組み立てる (シミュレータは融合命令で O(2ⁿ)、実機では分解される) */
export function buildQaoaCircuit(
  normalized: Qubo,
  gamma: number[],
  beta: number[],
  mixer: MixerKind,
  cardinality?: number,
  precomputedDiag?: Float64Array
): Circuit {
  const n = normalized.n;
  const diag = precomputedDiag ?? energyDiagonal(normalized);
  const circuit = new Circuit(n);

  if (mixer === "x") {
    for (let i = 0; i < n; i++) circuit.gate("h", i);
  } else {
    const k = cardinality ?? Math.floor(n / 2);
    circuit.opaque({
      name: `dicke(n=${n},k=${k})`,
      qubits: Array.from({ length: n }, (_, i) => i),
      apply: (sv) => prepareDicke(sv, k),
      // Bärtschi & Eidenbenz 2019: 決定論的 Dicke 状態生成は O(kn) ゲート / O(n) 深さ
      estimate: { gates1q: 3 * k * n, gates2q: 2 * k * n, depth: 4 * n },
      note:
        `Dicke 状態生成 (Bärtschi & Eidenbenz 2019, O(kn) ゲート)。` +
        `等価回路を明示展開していないため、この回路は OpenQASM 出力では不完全になる。`,
    });
  }

  for (let l = 0; l < gamma.length; l++) {
    const g = gamma[l];
    // 位相配列は 2ⁿ 要素あるので、実際にシミュレータで実行されるまで作らない
    // (資源見積り・QASM 出力だけが目的のときは確保コストが無駄になる)
    let theta: Float64Array | null = null;
    circuit.fused({
      name: `cost(gamma=${g.toPrecision(6)})`,
      qubits: Array.from({ length: n }, (_, i) => i),
      apply: (sv) => {
        if (!theta) {
          theta = new Float64Array(diag.length);
          for (let b = 0; b < diag.length; b++) theta[b] = g * diag[b];
        }
        sv.applyDiagonalPhase(theta);
      },
      expand: () => costLayerGates(normalized, g),
    });

    const b = beta[l];
    if (mixer === "x") {
      for (let i = 0; i < n; i++) circuit.gate("rx", i, [2 * b]);
    } else {
      for (const [i, j] of ringPairs(n)) {
        circuit.opaque({
          name: `xy(${i},${j})`,
          qubits: [i, j],
          apply: (sv) => applyXYPair(sv, i, j, b),
          // (XX+YY)/2 の時間発展は iSWAP 型: CX 2個 + 1量子ビット回転 4個
          estimate: { gates1q: 4, gates2q: 2, depth: 6 },
          note: "XX+YY 相互作用 (iSWAP型, CX 2個相当)。標準ゲートへの展開は未実装。",
        });
      }
    }
  }
  return circuit;
}

/**
 * リングミキサーの Trotter 分割: 偶数ペア → 奇数ペア → 折り返し。
 * XX+YY の項は互いに非可換なので、この 1 次 Trotter 分割で近似する
 * (可換な偶数側・奇数側をまとめると深さが O(1) に収まる)。
 */
export function ringPairs(n: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < n; i += 2) pairs.push([i, i + 1]);
  for (let i = 1; i + 1 < n; i += 2) pairs.push([i, i + 1]);
  if (n > 2) pairs.push([n - 1, 0]);
  return pairs;
}

/** 下位 α 分位の条件付き期待値 (CVaR)。energyOrder は昇順のインデックス列 */
export function cvar(
  probs: Float64Array,
  energyOrder: Int32Array,
  diag: Float64Array,
  alpha: number
): number {
  if (alpha >= 1) {
    let e = 0;
    for (let b = 0; b < probs.length; b++) e += probs[b] * diag[b];
    return e;
  }
  let acc = 0;
  let sum = 0;
  for (let k = 0; k < energyOrder.length; k++) {
    const b = energyOrder[k];
    const p = probs[b];
    if (p <= 0) continue;
    const take = Math.min(p, alpha - acc);
    sum += take * diag[b];
    acc += take;
    if (acc >= alpha - 1e-15) break;
  }
  return acc > 0 ? sum / acc : 0;
}

export function runQaoa(qubo: Qubo, opts: QaoaOptions = {}): QaoaResult {
  const p = opts.layers ?? 3;
  const shots = opts.shots ?? 1024;
  const alpha = opts.cvarAlpha ?? 0.15;
  const mixer: MixerKind = opts.mixer ?? (opts.cardinality != null ? "xy" : "x");
  const K = opts.cardinality;
  if (mixer === "xy" && K == null) {
    throw new Error("XY ミキサーには cardinality が必要 (保存量が決まらない)");
  }
  const rng = mulberry32(opts.seed ?? 20260805);
  const now = opts.now ?? (() => Date.now());

  const n = qubo.n;
  const dim = 1 << n;
  const dickeMasks = mixer === "xy" ? weightKMasks(n, K!) : new Int32Array(0);
  const feasible =
    mixer === "xy" && K != null ? (b: number) => popcount(b) === K : undefined;
  const { qubo: nq, diag } = normalizeQubo(qubo, feasible);

  // --- シミュレーション経路の選択 ---
  // XY: 重み K セクタだけを回す (C(n,K) 次元)
  // X : 完全な状態ベクトル (2ⁿ 次元)
  //
  // どちらの経路でも「探索空間の位置 d」で統一的に扱う:
  //   spaceMask[d]   … その位置に対応するビット列
  //   spaceEnergy[d] … 正規化済みエネルギー
  // こうしておくと CVaR も読み出しも 2ⁿ の配列を作らずに済む。
  const sector =
    mixer === "xy" ? new WeightSectorState(n, K!, dickeMasks) : null;
  const spaceMask = sector
    ? sector.masks
    : Int32Array.from({ length: dim }, (_, i) => i);
  const spaceEnergy = sector
    ? sectorEnergies(dickeMasks, diag)
    : diag;
  const sectorPairs = sector
    ? ringPairs(n).map(([i, j]) => buildXYTranspositions(sector, i, j))
    : [];
  const sv = sector ? null : new StateVector(n);
  const theta = sector ? null : new Float64Array(dim);

  // 探索空間をエネルギー昇順に並べる (パラメータに依らないので一度だけ)
  const order = Int32Array.from(
    Array.from({ length: spaceMask.length }, (_, d) => d).sort(
      (a, b) => spaceEnergy[a] - spaceEnergy[b]
    )
  );

  /** 現在のパラメータで状態を作り、探索空間上の確率分布を返す */
  const prepare = (params: number[]): Float64Array => {
    if (sector) {
      sector.prepareUniform();
      for (let l = 0; l < p; l++) {
        sector.applyDiagonalPhase(params[l], spaceEnergy);
        const b = params[p + l];
        for (const tr of sectorPairs) sector.applyXY(tr, b);
      }
      return sector.probabilities();
    }
    sv!.reset();
    for (let i = 0; i < n; i++) sv!.applyGate(i, HADAMARD);
    for (let l = 0; l < p; l++) {
      const g = params[l];
      for (let b = 0; b < dim; b++) theta![b] = g * diag[b];
      sv!.applyDiagonalPhase(theta!);
      const m = rxMatrix(2 * params[p + l]);
      for (let i = 0; i < n; i++) sv!.applyGate(i, m);
    }
    return sv!.probabilities();
  };

  const objective = (params: number[]): number =>
    cvar(prepare(params), order, spaceEnergy, alpha);

  // 初期値: γ は線形増加、β は線形減少 (断熱スケジュールの離散化)
  const x0: number[] = [];
  for (let l = 0; l < p; l++) x0.push((Math.PI * (l + 1)) / (p + 1));
  for (let l = 0; l < p; l++) x0.push((Math.PI / 4) * (1 - l / (p + 1)));

  const opt = nelderMead(objective, x0, {
    maxEvals: opts.maxEvals ?? 80 * p,
    timeBudgetMs: opts.timeBudgetMs,
    step: 0.35,
    now,
  });

  const gamma = opt.x.slice(0, p);
  const beta = opt.x.slice(p);
  const probs = prepare(opt.x);

  // 実機と同じく「測定して一番良かったビット列」を解として採る。
  // order はエネルギー昇順なので、最初に観測された要素がそのまま最良。
  const counts = sector
    ? sector.sample(shots, rng)
    : sv!.sample(shots, rng);
  let bestPos = -1;
  for (let i = 0; i < order.length; i++) {
    if (counts[order[i]] > 0) {
      bestPos = order[i];
      break;
    }
  }
  if (bestPos < 0) bestPos = order[0] ?? 0;
  const bestMask = spaceMask[bestPos];

  let expectation = 0;
  for (let d = 0; d < probs.length; d++) expectation += probs[d] * spaceEnergy[d];

  // 制約部分空間から漏れた確率。XY 経路は保存則により厳密に 0
  // (セクタの外に振幅が存在しないため)。X 経路はペナルティ頼りなので実測する。
  let leakage = 0;
  if (!sector && K != null) {
    for (let b = 0; b < dim; b++) if (popcount(b) !== K) leakage += probs[b];
  }

  const circuit = buildQaoaCircuit(nq, gamma, beta, mixer, K, diag);

  return {
    bestMask,
    bestEnergy: energyOfMask(qubo, bestMask),
    expectation,
    cvar: opt.fx,
    gamma,
    beta,
    evals: opt.evals,
    shots,
    mixer,
    bestProbability: probs[bestPos],
    leakage,
    resources: circuit.estimate(),
    circuit,
  };
}

const S2 = Math.SQRT1_2;
const HADAMARD = [S2, 0, S2, 0, S2, 0, -S2, 0] as const;

function rxMatrix(theta: number) {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, 0, -s, 0, -s, c, 0] as const;
}
