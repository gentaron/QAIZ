import {
  buildBasketQubo,
  describeSolution,
  type BasketInput,
  type BasketSolution,
} from "../problems/basket.ts";
import { analyzeTailRisk, type TailRiskInput, type TailRiskResult } from "../problems/tailrisk.ts";
import { binomial } from "./ledger.ts";
import {
  solveExact,
  solveQaoa,
  solveSimulatedAnnealing,
  type QuboSolution,
} from "./backends.ts";
import {
  appendEntry,
  emptyLedger,
  exactEnumerationWall,
  verdictHeuristicOnly,
  verdictQueryModel,
  verdictWithExact,
  type Ledger,
  type LedgerEntry,
  type SolverRun,
} from "./ledger.ts";

/**
 * QAIZ 量子OS カーネル。
 *
 * 「量子OS」を名乗るからには、少なくとも OS がやることをやる必要がある:
 *
 *   1. **抽象化**  — 問題を「どの計算資源でも解ける形」(QUBO / 振幅推定) に落とす
 *   2. **スケジューリング** — CPU 予算内で、どのバックエンドを何個走らせるか決める
 *   3. **計測**   — 全バックエンドの実コストを同一尺度で記録する
 *   4. **判定**   — 量子が勝ったか負けたかを、測定値に基づいて宣言する
 *
 * 4 が本体である。既存の「量子っぽい名前の古典統計量」と決定的に違うのは、
 * ここが **負けを記録できる** 構造になっている点。
 *
 * Cloudflare Workers 無料プランは 1 実行あたりの CPU 時間が厳しいので、
 * カーネルは常に残予算を見ながらバックエンドを足し引きする。
 */

export interface KernelOptions {
  /** この呼び出しで使ってよい CPU 時間の総量 (ms) */
  budgetMs: number;
  seed?: number;
  now?: () => number;
  /** QAOA を回す上限量子ビット数 */
  maxQaoaQubits?: number;
  /** 厳密列挙を許す最大候補数 */
  maxExactCandidates?: number;
  /** QAOA の層数 */
  qaoaLayers?: number;
}

export interface BasketJobResult {
  solution: BasketSolution;
  /** 厳密解 (取れた場合) */
  exact: BasketSolution | null;
  runs: SolverRun[];
  entry: LedgerEntry;
  /** 厳密列挙が 10⁹ 候補を超える資産数 = 量子の出番が始まりうる境界 */
  exactWallAt: number;
}

export interface TailRiskJobResult {
  risk: TailRiskResult;
  runs: SolverRun[];
  entry: LedgerEntry;
}

const DEFAULTS = {
  maxQaoaQubits: 16,
  maxExactCandidates: 2_000_000,
  qaoaLayers: 2,
};

/**
 * ジョブ 1: 基数制約付きバスケット選択。
 *
 * 方針 (policy):
 *  - 厳密列挙が予算内なら **必ず** 走らせる。近似比の分母が無い比較は無意味。
 *  - 古典 SA は常に走らせる。量子の対抗馬は「古典の最善」でなければならない。
 *  - QAOA はシミュレータ上限内かつ残予算がある場合のみ。
 */
export function runBasketJob(
  input: BasketInput,
  opts: KernelOptions
): BasketJobResult {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const deadline = t0 + opts.budgetMs;
  const maxQaoaQubits = opts.maxQaoaQubits ?? DEFAULTS.maxQaoaQubits;
  const maxExact = opts.maxExactCandidates ?? DEFAULTS.maxExactCandidates;

  // 3 つのバックエンドすべてが基数制約を **構造的に** 満たすので
  // (厳密=重みK列挙 / SA=スワップ近傍 / QAOA=XYミキサー+Dicke状態)、
  // ペナルティ項は不要。入れると目的関数のレンジが制約違反状態に支配され、
  // 比較そのものが歪む。
  const qubo = buildBasketQubo({ ...input, penalty: 0 });
  const n = input.ids.length;
  const K = input.cardinality;
  const runs: SolverRun[] = [];

  // --- 厳密解 ---
  const candidates = binomial(n, K);
  let exactSol: QuboSolution | null = null;
  if (candidates <= maxExact) {
    exactSol = solveExact(qubo, K, { budgetMs: deadline - now(), seed: opts.seed, now });
    runs.push(exactSol.run);
  } else {
    runs.push({
      backend: "exact-enumeration",
      kind: "classical",
      wallMs: 0,
      queries: 0,
      ok: false,
      error: `候補数 ${Math.round(candidates).toExponential(2)} が上限 ${maxExact.toExponential(2)} を超過`,
    });
  }

  // --- 古典ヒューリスティクス ---
  const saBudget = Math.max(1, Math.min(deadline - now(), opts.budgetMs * 0.3));
  const sa = solveSimulatedAnnealing(qubo, K, {
    budgetMs: saBudget,
    seed: opts.seed,
    now,
  });
  runs.push(sa.run);

  // --- 量子 (シミュレータ) ---
  let qaoa: QuboSolution | null = null;
  const remaining = deadline - now();
  if (n <= maxQaoaQubits && remaining > 5) {
    qaoa = solveQaoa(qubo, K, {
      budgetMs: remaining,
      seed: opts.seed,
      layers: opts.qaoaLayers ?? DEFAULTS.qaoaLayers,
      maxQubits: maxQaoaQubits,
      now,
    });
    runs.push(qaoa.run);
  } else {
    runs.push({
      backend: "qaoa-xy-statevector",
      kind: "quantum-sim",
      wallMs: 0,
      queries: 0,
      ok: false,
      error:
        n > maxQaoaQubits
          ? `n=${n} > 状態ベクトルシミュレータ上限 ${maxQaoaQubits} 量子ビット`
          : "CPU 予算不足によりスキップ",
    });
  }

  // --- 採用解: 実行できたバックエンドの中で最良 (厳密解があればそれ) ---
  const finalists = [exactSol, sa, qaoa].filter(
    (s): s is QuboSolution => s !== null && s.run.ok && s.mask >= 0
  );
  const bestSol = finalists.reduce(
    (a, b) => (b.energy < a.energy ? b : a),
    finalists[0] ?? { mask: 0, energy: Infinity, run: sa.run }
  );

  const solution = describeSolution(input, qubo, bestSol.mask);
  const exact = exactSol ? describeSolution(input, qubo, exactSol.mask) : null;

  // --- 判定 ---
  const quantumRun = qaoa?.run;
  const verdict = exactSol
    ? verdictWithExact(exactSol.run, quantumRun, n)
    : verdictHeuristicOnly(sa.run, quantumRun, n);

  const quality =
    exactSol && qaoa && qaoa.run.ok
      ? {
          exactOptimum: exactSol.energy,
          achieved: qaoa.energy,
          approximationRatio: approximationRatio(
            exactSol.energy,
            qaoa.energy,
            exactSol.worstEnergy
          ),
        }
      : undefined;

  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    problem: "basket-qubo",
    size: n,
    runs,
    quality,
    verdict,
    summary: summarizeBasket(n, K, exactSol, sa, qaoa, quality),
  };

  return {
    solution,
    exact,
    runs,
    entry,
    exactWallAt: exactEnumerationWall(K),
  };
}

/**
 * ジョブ 2: テールリスク推定。
 * ここは古典 MC と量子振幅推定を必ず両方走らせ、クエリ数を突き合わせる。
 */
export function runTailRiskJob(
  input: TailRiskInput,
  opts: KernelOptions
): TailRiskJobResult {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const risk = analyzeTailRisk({ ...input, seed: input.seed ?? opts.seed });
  const wall = now() - t0;

  const runs: SolverRun[] = [
    {
      backend: "monte-carlo",
      kind: "classical",
      wallMs: wall / 2,
      queries: risk.classical.requiredSamples,
      value: risk.classical.estimate,
      ok: true,
      detail: { epsilon: risk.epsilon },
    },
    {
      backend: "iqae-statevector",
      kind: "quantum-sim",
      wallMs: wall / 2,
      queries: risk.quantum.oracleCalls,
      value: risk.quantum.estimate,
      ok: risk.quantum.converged,
      detail: {
        rounds: risk.quantum.rounds,
        qubits: risk.quantum.resources.qubits,
        gates2q: risk.quantum.resources.gates2q,
        depth: risk.quantum.resources.depth,
      },
    },
  ];

  const verdict = verdictQueryModel(
    risk.classical.requiredSamples,
    risk.quantum.oracleCalls,
    risk.epsilon
  );

  const entry: LedgerEntry = {
    ts: new Date().toISOString(),
    problem: "tail-amplitude",
    size: risk.qubits,
    runs,
    verdict,
    summary:
      `テール確率 P[損失≥${(risk.varThreshold * 100).toFixed(2)}%] を ε=${risk.epsilon} で推定: ` +
      `真値 ${(risk.exactTailProbability * 100).toFixed(2)}% / ` +
      `IQAE ${(risk.quantum.estimate * 100).toFixed(2)}% ` +
      `(オラクル ${risk.quantum.oracleCalls.toLocaleString()} 回) vs ` +
      `古典 ${risk.classical.requiredSamples.toLocaleString()} サンプル必要。`,
  };

  return { risk, runs, entry };
}

/**
 * 近似比 (最小化問題)。
 *
 *   r = (E_worst − E_achieved) / (E_worst − E_optimum) ∈ [0, 1]
 *
 * 1.0 で厳密解一致、0.0 で探索空間の最悪解。
 * エネルギーは負にもなるので単純な比 E_opt/E_ach は意味を持たない
 * (符号やオフセットで幾らでも化ける)。探索空間のレンジで正規化するのが、
 * QAOA 文献でも使われている唯一まともな定義。
 */
export function approximationRatio(
  optimum: number,
  achieved: number,
  worst?: number
): number {
  if (worst == null || !Number.isFinite(worst)) return NaN;
  const span = worst - optimum;
  if (!(span > 1e-15)) return 1; // 全解が同値なら比較する意味がない
  return Math.max(0, Math.min(1, (worst - achieved) / span));
}

function summarizeBasket(
  n: number,
  K: number,
  exact: QuboSolution | null,
  sa: QuboSolution,
  qaoa: QuboSolution | null,
  quality: { approximationRatio: number } | undefined
): string {
  const parts = [`n=${n} から K=${K} 本を選択 (候補 ${Math.round(binomial(n, K)).toLocaleString()} 通り)`];
  if (exact) parts.push(`厳密 E=${exact.energy.toPrecision(6)} (${exact.run.wallMs.toFixed(1)}ms)`);
  parts.push(`SA E=${sa.energy.toPrecision(6)} (${sa.run.wallMs.toFixed(1)}ms)`);
  if (qaoa?.run.ok) {
    parts.push(
      `QAOA E=${qaoa.energy.toPrecision(6)} (${qaoa.run.wallMs.toFixed(1)}ms` +
        (quality ? `, 近似比 ${quality.approximationRatio.toFixed(4)}` : "") +
        ")"
    );
  } else if (qaoa) {
    parts.push(`QAOA: ${qaoa.run.error}`);
  }
  return parts.join(" / ");
}

/** 台帳をまとめて更新する (呼び出し側は永続化だけ担当) */
export function recordEntries(ledger: Ledger | null, entries: LedgerEntry[]): Ledger {
  let out = ledger ?? emptyLedger();
  for (const e of entries) out = appendEntry(out, e);
  return out;
}
