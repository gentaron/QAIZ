import test from "node:test";
import assert from "node:assert/strict";

import { mulberry32 } from "../src/quantum/rng.ts";
import {
  addLinear,
  addQuadratic,
  energyDiagonal,
  energyOfMask,
  isingEnergyOfMask,
  makeQubo,
  popcount,
  quboToIsing,
  type Qubo,
} from "../src/quantum/qubo.ts";

/** ランダムな QUBO を作る (対称性を保つよう addQuadratic を通す) */
function randomQubo(n: number, seed: number): Qubo {
  const rng = mulberry32(seed);
  const q = makeQubo(n);
  q.offset = (rng() - 0.5) * 2;
  for (let i = 0; i < n; i++) {
    addLinear(q, i, (rng() - 0.5) * 4);
    for (let j = i; j < n; j++) addQuadratic(q, i, j, (rng() - 0.5) * 2);
  }
  return q;
}

test("popcount は立っているビット数を返す", () => {
  assert.equal(popcount(0), 0);
  assert.equal(popcount(0b1011), 3);
  assert.equal(popcount(0xffff), 16);
});

test("energyDiagonal は energyOfMask と全基底で一致する", () => {
  for (const n of [1, 3, 6, 9]) {
    const q = randomQubo(n, n * 31 + 7);
    const diag = energyDiagonal(q);
    assert.equal(diag.length, 1 << n);
    for (let b = 0; b < 1 << n; b++) {
      assert.ok(
        Math.abs(diag[b] - energyOfMask(q, b)) < 1e-9,
        `n=${n} b=${b}: ${diag[b]} vs ${energyOfMask(q, b)}`
      );
    }
  }
});

test("空マスクのエネルギーは offset そのもの", () => {
  const q = randomQubo(5, 3);
  assert.ok(Math.abs(energyOfMask(q, 0) - q.offset) < 1e-12);
});

test("QUBO → Ising 変換はエネルギーを保存する", () => {
  for (const n of [2, 4, 7]) {
    const q = randomQubo(n, n * 13 + 1);
    const ising = quboToIsing(q);
    for (let b = 0; b < 1 << n; b++) {
      assert.ok(
        Math.abs(energyOfMask(q, b) - isingEnergyOfMask(ising, b)) < 1e-9,
        `n=${n} b=${b}`
      );
    }
  }
});

test("x_i² = x_i: 対角の二次項は線形項と同じ効果を持つ", () => {
  const a = makeQubo(2);
  addQuadratic(a, 0, 0, 3);
  const b = makeQubo(2);
  addLinear(b, 0, 3);
  for (let m = 0; m < 4; m++) {
    assert.ok(Math.abs(energyOfMask(a, m) - energyOfMask(b, m)) < 1e-12);
  }
});

test("addQuadratic(i,j,v) は x_i x_j の係数 v を意味する", () => {
  const q = makeQubo(2);
  addQuadratic(q, 0, 1, 5);
  assert.equal(energyOfMask(q, 0b11), 5);
  assert.equal(energyOfMask(q, 0b01), 0);
  assert.equal(energyOfMask(q, 0b10), 0);
});
