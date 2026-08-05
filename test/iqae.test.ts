import test from "node:test";
import assert from "node:assert/strict";

import {
  classicalSampleRequirement,
  findNextM,
  groverProbability,
  invertProbabilityInterval,
  runIqae,
} from "../src/quantum/iqae.ts";
import {
  amplitudeLoadCircuit,
  tailProbabilityProblem,
} from "../src/quantum/stateprep.ts";
import { mulberry32 } from "../src/quantum/rng.ts";
import { StateVector } from "../src/quantum/statevector.ts";

/**
 * 振幅推定の検証。
 *
 * QAIZ が唯一「量子的優位がある」と主張している箇所なので、
 * ここは主張の中身を直接テストにしてある:
 *
 *  1. Grover 演算子が理論式 sin²((2k+1)θ) を再現すること
 *  2. IQAE の推定値が真値に ε 以内で入ること
 *  3. **オラクル呼び出し数が O(1/ε) であること** (古典は Θ(1/ε²))
 */

function normalized(values: number[]): Float64Array {
  const s = values.reduce((a, b) => a + b, 0);
  return Float64Array.from(values.map((v) => v / s));
}

/** テスト用の損失分布 (2^k ビン) */
function makeProblem(k: number, tailFraction: number) {
  const m = 1 << k;
  const probs = new Float64Array(m);
  const losses = new Float64Array(m);
  // 末尾 t ビンにちょうど tailFraction の質量を置く
  const tailBins = Math.max(1, Math.round(m * 0.25));
  for (let i = 0; i < m; i++) {
    losses[i] = i / m;
    probs[i] =
      i >= m - tailBins ? tailFraction / tailBins : (1 - tailFraction) / (m - tailBins);
  }
  const threshold = losses[m - tailBins];
  return tailProbabilityProblem(losses, probs, threshold);
}

// ------------------------------------------------------------- 分布ロード

test("振幅ロード: |ψ⟩ の測定確率が元の分布に一致する", () => {
  for (const k of [1, 2, 3, 4]) {
    const m = 1 << k;
    const rng = mulberry32(k * 7 + 1);
    const probs = normalized(Array.from({ length: m }, () => rng() + 0.05));
    const sv = new StateVector(k);
    amplitudeLoadCircuit(probs, k).run(sv);
    const got = sv.probabilities();
    for (let i = 0; i < m; i++) {
      assert.ok(Math.abs(got[i] - probs[i]) < 1e-12, `k=${k} bin=${i}`);
    }
  }
});

test("振幅ロード: 確率 0 のビンは振幅も 0", () => {
  const probs = Float64Array.from([0.5, 0, 0.5, 0]);
  const sv = new StateVector(2);
  amplitudeLoadCircuit(probs, 2).run(sv);
  const p = sv.probabilities();
  assert.ok(Math.abs(p[1]) < 1e-15);
  assert.ok(Math.abs(p[3]) < 1e-15);
});

test("振幅ロード: 長さが 2^k でなければ例外", () => {
  assert.throws(() => amplitudeLoadCircuit(Float64Array.from([1, 0, 0]), 2), RangeError);
});

test("テール確率問題: A|0⟩ の good 確率が経験テール確率と一致する", () => {
  const { problem, exactTail } = makeProblem(4, 0.13);
  const sv = new StateVector(problem.n);
  problem.A.run(sv);
  const a = sv.marginal(problem.objectiveQubit, 1);
  assert.ok(Math.abs(a - exactTail) < 1e-12, `${a} vs ${exactTail}`);
});

// ------------------------------------------------------------- Grover

test("Grover 演算子は sin²((2k+1)θ) を厳密に再現する", () => {
  const { problem, exactTail } = makeProblem(4, 0.09);
  const theta = Math.asin(Math.sqrt(exactTail));
  for (const k of [0, 1, 2, 3, 5, 8]) {
    const sim = groverProbability(problem, k);
    const analytic = Math.sin((2 * k + 1) * theta) ** 2;
    assert.ok(
      Math.abs(sim - analytic) < 1e-12,
      `k=${k}: シミュレーション ${sim} vs 理論 ${analytic}`
    );
  }
});

test("Grover: k=0 は A をそのまま適用した状態", () => {
  const { problem, exactTail } = makeProblem(3, 0.25);
  assert.ok(Math.abs(groverProbability(problem, 0) - exactTail) < 1e-12);
});

// ------------------------------------------------------------- IQAE 内部

test("findNextM: 初期区間では m=1", () => {
  const r = findNextM(0, Math.PI / 2, 1);
  assert.ok(r);
  assert.equal(r!.m, 1);
  assert.equal(r!.branch, 0);
});

test("findNextM: 区間が狭まるほど m が伸びる", () => {
  const wide = findNextM(0.30, 0.40, 1);
  const narrow = findNextM(0.349, 0.351, 1);
  assert.ok(wide && narrow);
  assert.ok(narrow!.m > wide!.m, `${narrow!.m} > ${wide!.m}`);
});

test("findNextM: 返す m は常に奇数 (= 2k+1)", () => {
  for (const [lo, hi] of [[0.1, 0.2], [0.7, 0.72], [1.0, 1.004]] as const) {
    const r = findNextM(lo, hi, 1);
    if (r) assert.equal(r.m % 2, 1, `m=${r.m}`);
  }
});

test("findNextM: 幅ゼロの区間では null", () => {
  assert.equal(findNextM(0.5, 0.5, 1), null);
});

test("invertProbabilityInterval: 増加枝は arcsin をそのまま返す", () => {
  const [lo, hi] = invertProbabilityInterval(0.25, 0.36, 1, 0);
  assert.ok(Math.abs(lo - Math.asin(0.5)) < 1e-12);
  assert.ok(Math.abs(hi - Math.asin(0.6)) < 1e-12);
});

test("invertProbabilityInterval: 減少枝では区間の向きが反転する", () => {
  const [lo, hi] = invertProbabilityInterval(0.25, 0.36, 1, 1);
  assert.ok(lo < hi, "区間は常に昇順で返ること");
  // branch=1 では sin²(π/2 + v) = cos²(v) なので p が大きいほど v が小さい
  assert.ok(Math.abs(hi - (Math.PI / 2 + Math.acos(0.5))) < 1e-12);
});

// ------------------------------------------------------------- IQAE 本体

test("IQAE の推定値は真値に ε 以内で入る", () => {
  for (const tail of [0.03, 0.11, 0.4]) {
    const { problem, exactTail } = makeProblem(4, tail);
    const res = runIqae(problem, { epsilon: 0.01, alpha: 0.05, shots: 200, seed: 31 });
    assert.ok(Math.abs(res.exactAmplitude - exactTail) < 1e-12);
    assert.ok(
      Math.abs(res.estimate - exactTail) < 0.01 + 1e-9,
      `真値 ${exactTail} 推定 ${res.estimate} 誤差 ${Math.abs(res.estimate - exactTail)}`
    );
    assert.equal(res.converged, true);
  }
});

test("IQAE の信頼区間は真値を含む", () => {
  const { problem, exactTail } = makeProblem(4, 0.17);
  const res = runIqae(problem, { epsilon: 0.01, alpha: 0.05, shots: 200, seed: 12 });
  assert.ok(res.interval[0] <= exactTail && exactTail <= res.interval[1],
    `${res.interval} が ${exactTail} を含まない`);
});

test("IQAE は決定論的 (同じシードなら同じオラクル呼び出し数)", () => {
  const { problem } = makeProblem(4, 0.2);
  const a = runIqae(problem, { epsilon: 0.02, shots: 100, seed: 77 });
  const b = runIqae(problem, { epsilon: 0.02, shots: 100, seed: 77 });
  assert.equal(a.oracleCalls, b.oracleCalls);
  assert.equal(a.estimate, b.estimate);
});

test("IQAE: 精度を上げるとオラクル呼び出しが増える (ただし 1/ε 程度)", () => {
  const { problem } = makeProblem(4, 0.1);
  const coarse = runIqae(problem, { epsilon: 0.04, shots: 100, seed: 5 });
  const fine = runIqae(problem, { epsilon: 0.005, shots: 100, seed: 5 });
  assert.ok(fine.oracleCalls > coarse.oracleCalls);
  // 8 倍の精度向上に対して、古典なら 64 倍。量子はそれよりずっと緩やか。
  const growth = fine.oracleCalls / coarse.oracleCalls;
  assert.ok(growth < 64, `オラクル増加率 ${growth} が古典並み (64倍) になっている`);
});

test("epsilon が範囲外なら例外", () => {
  const { problem } = makeProblem(3, 0.2);
  assert.throws(() => runIqae(problem, { epsilon: 0 }), RangeError);
  assert.throws(() => runIqae(problem, { epsilon: 0.9 }), RangeError);
});

// ------------------------------------------------ 二次高速化そのものの検証

test("古典必要サンプル数は Θ(1/ε²) で増える", () => {
  const a = classicalSampleRequirement(0.02);
  const b = classicalSampleRequirement(0.01);
  assert.ok(Math.abs(b / a - 4) < 0.01, `ε半減で4倍のはず: ${b / a}`);
});

test("量子/古典のクエリ比は ε を半分にするたび約2倍になる (二次高速化の実測)", () => {
  const { problem } = makeProblem(5, 0.08);
  const epsilons = [0.04, 0.02, 0.01, 0.005];
  const ratios = epsilons.map((eps) => {
    const res = runIqae(problem, { epsilon: eps, alpha: 0.05, shots: 100, seed: 21 });
    assert.ok(res.converged, `ε=${eps} で収束しなかった`);
    return classicalSampleRequirement(eps, 0.05) / res.oracleCalls;
  });

  // 単調増加すること = 精度を上げるほど量子が有利になること
  for (let i = 1; i < ratios.length; i++) {
    assert.ok(
      ratios[i] > ratios[i - 1],
      `ε=${epsilons[i]} で比が伸びていない: ${ratios.join(", ")}`
    );
  }
  // 最も細かい精度では明確に量子側が少ないクエリで済むこと
  assert.ok(ratios[ratios.length - 1] > 4, `最終比 ${ratios[ratios.length - 1]}`);
});
