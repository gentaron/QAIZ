import test from "node:test";
import assert from "node:assert/strict";

import {
  basketReturns,
  buildBasketQubo,
  covarianceMatrix,
  describeSolution,
  type BasketInput,
} from "../src/problems/basket.ts";
import {
  analyzeTailRisk,
  conditionalValueAtRisk,
  empiricalVar,
  histogram,
} from "../src/problems/tailrisk.ts";
import { energyOfMask, popcount } from "../src/quantum/qubo.ts";
import { mulberry32 } from "../src/quantum/rng.ts";

function makeInput(n: number, seed: number, K: number): BasketInput {
  const rng = mulberry32(seed);
  const mu = new Float64Array(n);
  for (let i = 0; i < n; i++) mu[i] = rng();
  const sigma = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    sigma[i * n + i] = 0.5 + rng();
    for (let j = i + 1; j < n; j++) {
      const v = (rng() - 0.5) * 0.4;
      sigma[i * n + j] = v;
      sigma[j * n + i] = v;
    }
  }
  return { ids: Array.from({ length: n }, (_, i) => `A${i}`), mu, sigma, cardinality: K, riskAversion: 1 };
}

// ------------------------------------------------------------- 共分散

test("covarianceMatrix は対称で、対角が分散", () => {
  const rng = mulberry32(3);
  const series = Array.from({ length: 4 }, () =>
    Array.from({ length: 100 }, () => rng() - 0.5)
  );
  const n = 4;
  const cov = covarianceMatrix(series);
  for (let i = 0; i < n; i++) {
    assert.ok(cov[i * n + i] > 0, "分散は正");
    for (let j = 0; j < n; j++) {
      assert.ok(Math.abs(cov[i * n + j] - cov[j * n + i]) < 1e-15);
    }
  }
});

test("covarianceMatrix: 完全相関する2資産は共分散 = 分散 (対角のリッジ分だけ差が出る)", () => {
  const a = Array.from({ length: 50 }, (_, t) => Math.sin(t));
  const ridge = 1e-6;
  const cov = covarianceMatrix([a, a], ridge);
  // cov[0] は対角なのでリッジが乗る。cov[1] は非対角なので乗らない。
  assert.ok(Math.abs(cov[0] - cov[1] - ridge) < 1e-12, `${cov[0]} - ${cov[1]}`);
});

test("covarianceMatrix: 系列が短すぎてもクラッシュしない", () => {
  assert.doesNotThrow(() => covarianceMatrix([[1], [2]]));
  assert.doesNotThrow(() => covarianceMatrix([]));
});

// ------------------------------------------------------------- QUBO 構築

test("ペナルティ 0 の QUBO は −μᵀx + λxᵀΣx をそのまま表す", () => {
  const input = makeInput(5, 11, 2);
  const qubo = buildBasketQubo({ ...input, penalty: 0 });
  const n = 5;
  for (let mask = 0; mask < 1 << n; mask++) {
    let expected = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      expected -= input.mu[i];
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) expected += input.riskAversion * input.sigma[i * n + j];
      }
    }
    assert.ok(
      Math.abs(energyOfMask(qubo, mask) - expected) < 1e-9,
      `mask=${mask}: ${energyOfMask(qubo, mask)} vs ${expected}`
    );
  }
});

test("自動ペナルティは制約違反を確実に不利にする", () => {
  const input = makeInput(6, 5, 3);
  const qubo = buildBasketQubo(input); // penalty 自動決定
  let bestFeasible = Infinity;
  let bestInfeasible = Infinity;
  for (let mask = 0; mask < 1 << 6; mask++) {
    const e = energyOfMask(qubo, mask);
    if (popcount(mask) === 3) bestFeasible = Math.min(bestFeasible, e);
    else bestInfeasible = Math.min(bestInfeasible, e);
  }
  assert.ok(
    bestFeasible < bestInfeasible,
    `制約違反の方が得になっている: ${bestFeasible} vs ${bestInfeasible}`
  );
});

test("基数が範囲外なら例外", () => {
  const input = makeInput(4, 1, 2);
  assert.throws(() => buildBasketQubo({ ...input, cardinality: 0 }), RangeError);
  assert.throws(() => buildBasketQubo({ ...input, cardinality: 5 }), RangeError);
});

test("describeSolution は選択本数と実行可能性を正しく報告する", () => {
  const input = makeInput(5, 9, 2);
  const qubo = buildBasketQubo({ ...input, penalty: 0 });
  const ok = describeSolution(input, qubo, 0b00101);
  assert.equal(ok.selected.length, 2);
  assert.equal(ok.feasible, true);
  const bad = describeSolution(input, qubo, 0b00111);
  assert.equal(bad.feasible, false);
});

test("describeSolution の目的関数は期待リターン − λ×分散", () => {
  const input = makeInput(5, 4, 2);
  const qubo = buildBasketQubo({ ...input, penalty: 0 });
  const s = describeSolution(input, qubo, 0b01001);
  assert.ok(
    Math.abs(s.objective - (s.expectedReturn - input.riskAversion * s.variance)) < 1e-12
  );
});

test("basketReturns は選ばれた資産の等加重平均", () => {
  const rets = [
    [1, 2, 3],
    [3, 2, 1],
    [9, 9, 9],
  ];
  assert.deepEqual(basketReturns(rets, 0b011), [2, 2, 2]);
  assert.deepEqual(basketReturns(rets, 0b100), [9, 9, 9]);
  assert.deepEqual(basketReturns(rets, 0), []);
});

// ------------------------------------------------------------- テールリスク

test("histogram は 2 のべき乗ビンで確率 1 に正規化される", () => {
  const rng = mulberry32(8);
  const returns = Array.from({ length: 300 }, () => rng() - 0.5);
  const { probs, centers } = histogram(returns, 20);
  assert.equal(probs.length, 32, "2 のべき乗に切り上げ");
  assert.equal(centers.length, 32);
  const sum = Array.from(probs).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test("histogram: 定数系列でも壊れない", () => {
  const { probs } = histogram([0.01, 0.01, 0.01], 8);
  assert.ok(Math.abs(Array.from(probs).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test("histogram: 空入力は確率が全部 0", () => {
  const { probs } = histogram([], 8);
  assert.equal(Array.from(probs).reduce((a, b) => a + b, 0), 0);
});

test("empiricalVar は損失として正の値を返す", () => {
  const returns = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000);
  const v = empiricalVar(returns, 0.95);
  assert.ok(v > 0, `VaR=${v}`);
});

test("CVaR は VaR 以上 (定義上そうでなければならない)", () => {
  const rng = mulberry32(15);
  const returns = Array.from({ length: 500 }, () => (rng() - 0.5) * 0.06);
  const v = empiricalVar(returns, 0.95);
  const cv = conditionalValueAtRisk(returns, 0.95);
  assert.ok(cv >= v - 1e-12, `CVaR=${cv} < VaR=${v}`);
});

test("analyzeTailRisk: 量子推定が真値に ε 以内で入り、資源見積りが付く", () => {
  const rng = mulberry32(23);
  const returns = Array.from({ length: 400 }, () => (rng() - 0.5) * 0.05);
  const r = analyzeTailRisk({ returns, epsilon: 0.01, bins: 32, seed: 3 });

  assert.ok(
    Math.abs(r.quantum.estimate - r.exactTailProbability) < 0.01 + 1e-9,
    `量子 ${r.quantum.estimate} vs 真値 ${r.exactTailProbability}`
  );
  assert.equal(r.quantum.converged, true);
  assert.equal(r.qubits, 6, "32ビン = 5量子ビット + 補助1本");
  assert.ok(r.quantum.resources.gates2q > 0, "2量子ビットゲート数が計上されること");
  assert.ok(r.quantum.oracleCalls > 0);
});

test("analyzeTailRisk: 古典側も同じ分布から実際に推定している", () => {
  const rng = mulberry32(24);
  const returns = Array.from({ length: 400 }, () => (rng() - 0.5) * 0.05);
  const r = analyzeTailRisk({ returns, epsilon: 0.02, bins: 32, seed: 3 });
  assert.ok(
    Math.abs(r.classical.estimate - r.exactTailProbability) < 0.03,
    `古典 ${r.classical.estimate} vs 真値 ${r.exactTailProbability}`
  );
  assert.ok(r.classical.requiredSamples > 0);
});

test("analyzeTailRisk: 精度を上げるとクエリ優位が拡大する", () => {
  const rng = mulberry32(25);
  const returns = Array.from({ length: 500 }, () => (rng() - 0.5) * 0.05);
  const coarse = analyzeTailRisk({ returns, epsilon: 0.04, bins: 32, seed: 3 });
  const fine = analyzeTailRisk({ returns, epsilon: 0.005, bins: 32, seed: 3 });
  assert.ok(
    fine.queryAdvantage > coarse.queryAdvantage,
    `${fine.queryAdvantage} <= ${coarse.queryAdvantage}`
  );
});
