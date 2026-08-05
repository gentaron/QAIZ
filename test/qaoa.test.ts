import test from "node:test";
import assert from "node:assert/strict";

import {
  applyXYPair,
  buildQaoaCircuit,
  cvar,
  normalizeQubo,
  prepareDicke,
  ringPairs,
  runQaoa,
} from "../src/quantum/qaoa.ts";
import {
  addLinear,
  addQuadratic,
  energyDiagonal,
  energyOfMask,
  makeQubo,
  popcount,
  type Qubo,
} from "../src/quantum/qubo.ts";
import { mulberry32 } from "../src/quantum/rng.ts";
import {
  buildXYTranspositions,
  sectorEnergies,
  weightKMasks,
  WeightSectorState,
} from "../src/quantum/sector.ts";
import { StateVector } from "../src/quantum/statevector.ts";

function randomQubo(n: number, seed: number): Qubo {
  const rng = mulberry32(seed);
  const q = makeQubo(n);
  for (let i = 0; i < n; i++) {
    addLinear(q, i, (rng() - 0.5) * 2);
    for (let j = i + 1; j < n; j++) addQuadratic(q, i, j, (rng() - 0.5) * 1.5);
  }
  return q;
}

/** 重み K の中での最小エネルギーを総当たりで求める */
function bruteForceWeightK(q: Qubo, k: number): number {
  let best = Infinity;
  for (let b = 0; b < 1 << q.n; b++) {
    if (popcount(b) !== k) continue;
    best = Math.min(best, energyOfMask(q, b));
  }
  return best;
}

// ---------------------------------------------------------------- 正規化

test("normalizeQubo: 全基底のエネルギーが [0,1] に収まる", () => {
  const q = randomQubo(6, 11);
  const { qubo, diag } = normalizeQubo(q);
  const d2 = energyDiagonal(qubo);
  for (let b = 0; b < d2.length; b++) {
    assert.ok(d2[b] >= -1e-12 && d2[b] <= 1 + 1e-12, `b=${b} → ${d2[b]}`);
    assert.ok(Math.abs(d2[b] - diag[b]) < 1e-9, "返される diag と一致すること");
  }
});

test("normalizeQubo: 実行可能解を指定すると、その範囲でレンジを取る", () => {
  const q = randomQubo(6, 12);
  const K = 3;
  const { diag } = normalizeQubo(q, (b) => popcount(b) === K);
  let lo = Infinity;
  let hi = -Infinity;
  for (let b = 0; b < diag.length; b++) {
    if (popcount(b) !== K) continue;
    lo = Math.min(lo, diag[b]);
    hi = Math.max(hi, diag[b]);
  }
  assert.ok(Math.abs(lo) < 1e-12, "最小が 0");
  assert.ok(Math.abs(hi - 1) < 1e-12, "最大が 1");
});

test("normalizeQubo: 全解が同値でもゼロ除算しない", () => {
  const q = makeQubo(3);
  const { diag } = normalizeQubo(q);
  for (const d of diag) assert.ok(Number.isFinite(d));
});

// ---------------------------------------------------------------- CVaR

test("cvar(alpha=1) は通常の期待値", () => {
  const diag = Float64Array.from([1, 2, 3, 4]);
  const probs = Float64Array.from([0.1, 0.2, 0.3, 0.4]);
  const order = Int32Array.from([0, 1, 2, 3]);
  const expected = 0.1 * 1 + 0.2 * 2 + 0.3 * 3 + 0.4 * 4;
  assert.ok(Math.abs(cvar(probs, order, diag, 1) - expected) < 1e-12);
});

test("cvar は下位分位だけを見るので期待値以下になる", () => {
  const diag = Float64Array.from([1, 2, 3, 4]);
  const probs = Float64Array.from([0.25, 0.25, 0.25, 0.25]);
  const order = Int32Array.from([0, 1, 2, 3]);
  const mean = cvar(probs, order, diag, 1);
  const tail = cvar(probs, order, diag, 0.25);
  assert.ok(tail < mean);
  assert.ok(Math.abs(tail - 1) < 1e-12, "下位25% は最小値そのもの");
});

// ---------------------------------------------------------------- Dicke / XY

test("Dicke 状態は重み K の基底に一様分布する", () => {
  const n = 5;
  const K = 2;
  const sv = new StateVector(n);
  prepareDicke(sv, K);
  const p = sv.probabilities();
  const count = weightKMasks(n, K).length;
  assert.equal(count, 10); // C(5,2)
  for (let b = 0; b < 1 << n; b++) {
    if (popcount(b) === K) assert.ok(Math.abs(p[b] - 1 / count) < 1e-14);
    else assert.equal(p[b], 0);
  }
});

test("XY 相互作用はハミング重みを保存する", () => {
  const n = 4;
  const K = 2;
  const sv = new StateVector(n);
  prepareDicke(sv, K);
  for (const [i, j] of ringPairs(n)) applyXYPair(sv, i, j, 0.83);
  const p = sv.probabilities();
  let leaked = 0;
  for (let b = 0; b < 1 << n; b++) if (popcount(b) !== K) leaked += p[b];
  assert.ok(leaked < 1e-15, `重み K 外に漏れた確率 = ${leaked}`);
  assert.ok(Math.abs(sv.norm() - 1) < 1e-13);
});

test("XY 相互作用は β=0 で恒等", () => {
  const sv = new StateVector(3);
  prepareDicke(sv, 1);
  const before = Array.from(sv.probabilities());
  applyXYPair(sv, 0, 1, 0);
  assert.deepEqual(Array.from(sv.probabilities()), before);
});

test("セクタシミュレータは完全な状態ベクトルと一致する", () => {
  const n = 6;
  const K = 3;
  const q = randomQubo(n, 77);
  const { diag } = normalizeQubo(q, (b) => popcount(b) === K);
  const masks = weightKMasks(n, K);

  // --- セクタ側 ---
  const sector = new WeightSectorState(n, K, masks);
  const energies = sectorEnergies(masks, diag);
  const pairs = ringPairs(n).map(([i, j]) => buildXYTranspositions(sector, i, j));
  sector.prepareUniform();
  for (const [gamma, beta] of [[0.9, 0.4], [1.7, 0.25]] as const) {
    sector.applyDiagonalPhase(gamma, energies);
    for (const tr of pairs) sector.applyXY(tr, beta);
  }
  const sectorProbs = sector.probabilities();

  // --- 完全な状態ベクトル側 ---
  const sv = new StateVector(n);
  prepareDicke(sv, K);
  const theta = new Float64Array(1 << n);
  for (const [gamma, beta] of [[0.9, 0.4], [1.7, 0.25]] as const) {
    for (let b = 0; b < theta.length; b++) theta[b] = gamma * diag[b];
    sv.applyDiagonalPhase(theta);
    for (const [i, j] of ringPairs(n)) applyXYPair(sv, i, j, beta);
  }
  const fullProbs = sv.probabilities();

  for (let d = 0; d < masks.length; d++) {
    assert.ok(
      Math.abs(sectorProbs[d] - fullProbs[masks[d]]) < 1e-13,
      `mask=${masks[d]}: ${sectorProbs[d]} vs ${fullProbs[masks[d]]}`
    );
  }
  assert.ok(Math.abs(sector.norm() - 1) < 1e-13);
});

test("weightKMasks は C(n,k) 個を昇順で返す", () => {
  const masks = weightKMasks(6, 3);
  assert.equal(masks.length, 20);
  for (let i = 1; i < masks.length; i++) assert.ok(masks[i] > masks[i - 1]);
  for (const m of masks) assert.equal(popcount(m), 3);
});

test("ringPairs はリングを閉じる (全量子ビットが2回ずつ現れる)", () => {
  const n = 6;
  const seen = new Map<number, number>();
  for (const [i, j] of ringPairs(n)) {
    seen.set(i, (seen.get(i) ?? 0) + 1);
    seen.set(j, (seen.get(j) ?? 0) + 1);
  }
  assert.equal(seen.size, n);
  for (const [, c] of seen) assert.equal(c, 2);
});

// ---------------------------------------------------------------- QAOA 本体

test("QAOA+ (XY) の解は必ず基数制約を満たす", () => {
  const n = 8;
  const K = 3;
  const q = randomQubo(n, 101);
  const res = runQaoa(q, { cardinality: K, layers: 2, shots: 256, seed: 4 });
  assert.equal(popcount(res.bestMask), K);
  assert.equal(res.mixer, "xy");
  assert.equal(res.leakage, 0, "XY ミキサーは保存則により漏れが厳密に 0");
});

test("QAOA+ (XY) は総当たりの最適値に到達する (小規模)", () => {
  for (const seed of [1, 2, 3]) {
    const n = 8;
    const K = 3;
    const q = randomQubo(n, seed * 17);
    const optimum = bruteForceWeightK(q, K);
    const res = runQaoa(q, { cardinality: K, layers: 3, shots: 512, seed });
    assert.ok(
      res.bestEnergy <= optimum + 1e-9,
      `seed=${seed}: QAOA=${res.bestEnergy} > 最適=${optimum}`
    );
  }
});

test("QAOA は決定論的 (同じシードなら同じ解)", () => {
  const q = randomQubo(7, 55);
  const a = runQaoa(q, { cardinality: 3, layers: 2, shots: 128, seed: 8 });
  const b = runQaoa(q, { cardinality: 3, layers: 2, shots: 128, seed: 8 });
  assert.equal(a.bestMask, b.bestMask);
  assert.deepEqual(a.gamma, b.gamma);
});

test("X ミキサーは cardinality なしでも動く (制約なし最小化)", () => {
  const n = 6;
  const q = randomQubo(n, 21);
  const res = runQaoa(q, { mixer: "x", layers: 2, shots: 512, seed: 3 });
  assert.equal(res.mixer, "x");
  let optimum = Infinity;
  for (let b = 0; b < 1 << n; b++) optimum = Math.min(optimum, energyOfMask(q, b));
  assert.ok(res.bestEnergy <= optimum + 1e-9);
});

test("XY ミキサーに cardinality を渡さないと例外", () => {
  assert.throws(
    () => runQaoa(randomQubo(4, 1), { mixer: "xy" }),
    /cardinality/
  );
});

test("CPU 予算 0 なら初期シンプレックスだけで打ち切る", () => {
  const p = 4;
  const res = runQaoa(randomQubo(10, 5), {
    cardinality: 4,
    layers: p,
    shots: 64,
    seed: 2,
    timeBudgetMs: 0,
  });
  // Nelder-Mead の初期シンプレックスは 2p+1 点 = パラメータ数+1
  assert.equal(res.evals, 2 * p + 1, "反復を 1 回も回さないこと");
  assert.equal(popcount(res.bestMask), 4, "打ち切っても実行可能解は返る");
});

test("CPU 予算を絞ると評価回数が上限に達しない", () => {
  const p = 4;
  const res = runQaoa(randomQubo(12, 5), {
    cardinality: 5,
    layers: p,
    shots: 64,
    seed: 2,
    timeBudgetMs: 5,
    maxEvals: 400,
  });
  assert.ok(res.evals < 400, `予算を無視して回り切っている (evals=${res.evals})`);
  assert.equal(popcount(res.bestMask), 5);
});

// ---------------------------------------------------------------- 回路 IR

test("QAOA 回路の資源見積りは層数に比例して増える", () => {
  const q = randomQubo(6, 9);
  const { qubo: nq, diag } = normalizeQubo(q);
  const e1 = buildQaoaCircuit(nq, [0.5], [0.3], "x", undefined, diag).estimate();
  const e2 = buildQaoaCircuit(nq, [0.5, 0.5], [0.3, 0.3], "x", undefined, diag).estimate();
  assert.ok(e2.gates2q > e1.gates2q);
  assert.ok(e2.depth > e1.depth);
  assert.equal(e1.qubits, 6);
});

test("X ミキサーの QAOA 回路は OpenQASM3 に完全出力できる (実機投入可能)", () => {
  const q = randomQubo(4, 6);
  const { qubo: nq, diag } = normalizeQubo(q);
  const { source, complete } = buildQaoaCircuit(nq, [0.5], [0.3], "x", undefined, diag).toQasm3();
  assert.equal(complete, true);
  assert.match(source, /rz\(/);
  assert.match(source, /ctrl\(1\) @ x/);
});

test("XY ミキサーの回路は不透明命令を含むため未完成と報告される", () => {
  const q = randomQubo(4, 6);
  const { qubo: nq, diag } = normalizeQubo(q);
  const c = buildQaoaCircuit(nq, [0.5], [0.3], "xy", 2, diag);
  assert.equal(c.toQasm3().complete, false);
  assert.ok(c.estimate().notes.length > 0, "何が未分解かを注記すること");
});
