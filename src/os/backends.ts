import { runQaoa, type MixerKind } from "../quantum/qaoa.ts";
import { energyDiagonal, energyOfMask, popcount, type Qubo } from "../quantum/qubo.ts";
import { mulberry32 } from "../quantum/rng.ts";
import type { SolverRun } from "./ledger.ts";

/**
 * バックエンド群。同じ問題を別々の計算資源で解き、必ず横並びで比較できる形
 * (SolverRun) を返す。「量子だけ実行して速いと言う」ことを構造的に不可能にする。
 */

export interface SolveOptions {
  budgetMs: number;
  seed?: number;
  now?: () => number;
}

export interface QuboSolution {
  mask: number;
  energy: number;
  /** 探索空間内の最悪エネルギー (厳密列挙時のみ。近似比の基準線になる) */
  worstEnergy?: number;
  run: SolverRun;
}

const clock = (o: SolveOptions) => o.now ?? (() => Date.now());

/**
 * 厳密解法。基数 K が指定されていれば C(n,K) 通り、なければ 2ⁿ 通りを全列挙する。
 * これが「近似比」の分母になるので、可能な限り必ず走らせる。
 */
export function solveExact(
  qubo: Qubo,
  cardinality: number | null,
  opts: SolveOptions
): QuboSolution {
  const now = clock(opts);
  const t0 = now();
  const n = qubo.n;
  let best = -1;
  let bestE = Infinity;
  let worstE = -Infinity;
  let queries = 0;

  if (cardinality == null) {
    const diag = energyDiagonal(qubo);
    for (let b = 0; b < diag.length; b++) {
      queries++;
      if (diag[b] < bestE) {
        bestE = diag[b];
        best = b;
      }
      if (diag[b] > worstE) worstE = diag[b];
    }
  } else if (cardinality === 0) {
    best = 0;
    bestE = energyOfMask(qubo, 0);
    worstE = bestE;
    queries = 1;
  } else {
    // 基数 K のマスクだけを Gosper's hack で列挙する
    let mask = (1 << cardinality) - 1;
    const limit = 1 << n;
    while (mask < limit) {
      queries++;
      const e = energyOfMask(qubo, mask);
      if (e < bestE) {
        bestE = e;
        best = mask;
      }
      if (e > worstE) worstE = e;
      const c = mask & -mask;
      const r = mask + c;
      mask = (((r ^ mask) >>> 2) / c) | r;
    }
  }

  return {
    mask: best,
    energy: bestE,
    worstEnergy: worstE,
    run: {
      backend: "exact-enumeration",
      kind: "classical",
      wallMs: now() - t0,
      queries,
      value: bestE,
      ok: best >= 0,
      detail: { cardinality: cardinality ?? -1 },
    },
  };
}

/**
 * 焼きなまし法。量子アニーリングの古典対抗馬であり、
 * 実務では「量子より先にこれを試せ」と言われ続けている本命。
 */
export function solveSimulatedAnnealing(
  qubo: Qubo,
  cardinality: number | null,
  opts: SolveOptions & { restarts?: number; sweeps?: number }
): QuboSolution {
  const now = clock(opts);
  const t0 = now();
  const rng = mulberry32(opts.seed ?? 20260805);
  const n = qubo.n;
  const restarts = opts.restarts ?? 8;
  const sweeps = opts.sweeps ?? 200;
  const deadline = t0 + opts.budgetMs;

  let best = -1;
  let bestE = Infinity;
  let queries = 0;

  for (let r = 0; r < restarts; r++) {
    // 1 回目は予算を無視して必ず回す。予算切れで「解なし」を返すくらいなら、
    // 粗くても実行可能解を返す方が呼び出し側にとって有用。
    if (r > 0 && now() > deadline) break;
    let mask = randomMask(n, cardinality, rng);
    let e = energyOfMask(qubo, mask);
    queries++;

    for (let s = 0; s < sweeps; s++) {
      if ((s & 15) === 0 && now() > deadline) break;
      const temp = 1.0 * Math.exp(-4 * (s / sweeps)) + 1e-4;
      for (let step = 0; step < n; step++) {
        const cand =
          cardinality == null
            ? mask ^ (1 << Math.floor(rng() * n))
            : swapMove(mask, n, cardinality, rng);
        const eCand = energyOfMask(qubo, cand);
        queries++;
        const d = eCand - e;
        if (d <= 0 || rng() < Math.exp(-d / temp)) {
          mask = cand;
          e = eCand;
        }
      }
    }
    if (e < bestE) {
      bestE = e;
      best = mask;
    }
  }

  return {
    mask: best,
    energy: bestE,
    run: {
      backend: "simulated-annealing",
      kind: "classical",
      wallMs: now() - t0,
      queries,
      value: bestE,
      ok: best >= 0,
      detail: { restarts, sweeps },
    },
  };
}

/**
 * QAOA バックエンド (状態ベクトルシミュレータ上で実行)。
 * 基数制約があるときは XY ミキサー + Dicke 初期状態を使い、
 * 制約部分空間から出ないようにする (ペナルティ方式より明確に解が良い)。
 */
export function solveQaoa(
  qubo: Qubo,
  cardinality: number | null,
  opts: SolveOptions & {
    layers?: number;
    shots?: number;
    maxQubits?: number;
    mixer?: MixerKind;
  }
): QuboSolution {
  const now = clock(opts);
  const t0 = now();
  const maxQubits = opts.maxQubits ?? 16;
  const mixer: MixerKind = opts.mixer ?? (cardinality != null ? "xy" : "x");
  const backend = `qaoa-${mixer}-statevector`;

  if (qubo.n > maxQubits) {
    return {
      mask: -1,
      energy: Infinity,
      run: {
        backend,
        kind: "quantum-sim",
        wallMs: 0,
        queries: 0,
        ok: false,
        error: `n=${qubo.n} > シミュレータ上限 ${maxQubits} 量子ビット`,
      },
    };
  }

  try {
    const res = runQaoa(qubo, {
      layers: opts.layers ?? 3,
      shots: opts.shots ?? 512,
      seed: opts.seed ?? 20260805,
      timeBudgetMs: opts.budgetMs,
      mixer,
      cardinality: cardinality ?? undefined,
      now,
    });
    return {
      mask: res.bestMask,
      energy: res.bestEnergy,
      run: {
        backend,
        kind: "quantum-sim",
        wallMs: now() - t0,
        // QAOA の「作業量」= 目的関数評価 (回路実行) 回数 + 読み出しショット数
        queries: res.evals + res.shots,
        value: res.bestEnergy,
        ok: res.bestMask >= 0,
        detail: {
          mixer: res.mixer,
          layers: res.gamma.length,
          shots: res.shots,
          bestProbability: res.bestProbability,
          leakage: res.leakage,
          gates2q: res.resources.gates2q,
          depth: res.resources.depth,
          qubits: res.resources.qubits,
        },
      },
    };
  } catch (e) {
    return {
      mask: -1,
      energy: Infinity,
      run: {
        backend,
        kind: "quantum-sim",
        wallMs: now() - t0,
        queries: 0,
        ok: false,
        error: String(e),
      },
    };
  }
}

function randomMask(n: number, cardinality: number | null, rng: () => number): number {
  if (cardinality == null) {
    let m = 0;
    for (let i = 0; i < n; i++) if (rng() < 0.5) m |= 1 << i;
    return m;
  }
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  let m = 0;
  for (let i = 0; i < cardinality; i++) m |= 1 << idx[i];
  return m;
}

/** 基数を保つ近傍: 入っている1本と出ている1本を入れ替える */
function swapMove(mask: number, n: number, k: number, rng: () => number): number {
  const inside: number[] = [];
  const outside: number[] = [];
  for (let i = 0; i < n; i++) (mask & (1 << i) ? inside : outside).push(i);
  if (inside.length === 0 || outside.length === 0) return mask;
  const a = inside[Math.floor(rng() * inside.length)];
  const b = outside[Math.floor(rng() * outside.length)];
  return (mask & ~(1 << a)) | (1 << b);
}

export { popcount };
