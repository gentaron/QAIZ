import test from "node:test";
import assert from "node:assert/strict";

import { Circuit } from "../src/quantum/circuit.ts";
import { H, X, rx, ry, rz } from "../src/quantum/gates.ts";
import { mulberry32 } from "../src/quantum/rng.ts";
import { StateVector } from "../src/quantum/statevector.ts";

/**
 * 状態ベクトルシミュレータの検証。
 *
 * ここが間違っていると上の全部が嘘になるので、
 * 「教科書に答えが書いてある状態」だけを使って固定する。
 */

const CX_MATRIX = X;

test("初期状態は |0…0⟩", () => {
  const sv = new StateVector(3);
  const p = sv.probabilities();
  assert.equal(p[0], 1);
  for (let i = 1; i < p.length; i++) assert.equal(p[i], 0);
});

test("H|0⟩ = (|0⟩+|1⟩)/√2", () => {
  const sv = new StateVector(1);
  sv.applyGate(0, H);
  const p = sv.probabilities();
  assert.ok(Math.abs(p[0] - 0.5) < 1e-15);
  assert.ok(Math.abs(p[1] - 0.5) < 1e-15);
});

test("H を2回かけると恒等 (ユニタリ性の最小確認)", () => {
  const sv = new StateVector(2);
  sv.applyGate(1, H);
  sv.applyGate(1, H);
  assert.ok(Math.abs(sv.probabilities()[0] - 1) < 1e-14);
});

test("Bell 状態 (H + CNOT) は |00⟩ と |11⟩ が半々", () => {
  const sv = new StateVector(2);
  sv.applyGate(0, H);
  sv.applyControlledGate([0], 1, CX_MATRIX);
  const p = sv.probabilities();
  assert.ok(Math.abs(p[0b00] - 0.5) < 1e-15);
  assert.ok(Math.abs(p[0b11] - 0.5) < 1e-15);
  assert.equal(p[0b01], 0);
  assert.equal(p[0b10], 0);
});

test("GHZ 状態: 3量子ビットでも |000⟩ と |111⟩ のみ", () => {
  const sv = new StateVector(3);
  sv.applyGate(0, H);
  sv.applyControlledGate([0], 1, CX_MATRIX);
  sv.applyControlledGate([1], 2, CX_MATRIX);
  const p = sv.probabilities();
  assert.ok(Math.abs(p[0b000] - 0.5) < 1e-15);
  assert.ok(Math.abs(p[0b111] - 0.5) < 1e-15);
  let rest = 0;
  for (let b = 0; b < 8; b++) if (b !== 0 && b !== 7) rest += p[b];
  assert.ok(rest < 1e-15);
});

test("RY(θ)|0⟩ の |1⟩ 確率は sin²(θ/2)", () => {
  for (const theta of [0, 0.3, 1.0, Math.PI / 2, Math.PI]) {
    const sv = new StateVector(1);
    sv.applyGate(0, ry(theta));
    const expected = Math.sin(theta / 2) ** 2;
    assert.ok(
      Math.abs(sv.probabilities()[1] - expected) < 1e-14,
      `theta=${theta}`
    );
  }
});

test("RZ は確率分布を変えない (位相のみ)", () => {
  const sv = new StateVector(1);
  sv.applyGate(0, H);
  const before = Array.from(sv.probabilities());
  sv.applyGate(0, rz(1.234));
  const after = Array.from(sv.probabilities());
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(before[i] - after[i]) < 1e-15);
  }
});

test("任意ゲート列を通してもノルムは 1 のまま", () => {
  const sv = new StateVector(4);
  const rng = mulberry32(17);
  for (let i = 0; i < 60; i++) {
    const q = Math.floor(rng() * 4);
    const theta = rng() * Math.PI * 2;
    sv.applyGate(q, [rx, ry, rz][i % 3](theta));
    if (i % 5 === 0) {
      const c = (q + 1) % 4;
      sv.applyControlledGate([c], q, CX_MATRIX);
    }
  }
  assert.ok(Math.abs(sv.norm() - 1) < 1e-12);
});

test("多重制御ゲート: 制御が全て 1 のときだけ発火", () => {
  const sv = new StateVector(3);
  sv.applyControlledGate([0, 1], 2, CX_MATRIX);
  assert.equal(sv.probabilities()[0], 1, "制御が 0 なら何も起きない");

  const sv2 = new StateVector(3);
  sv2.applyGate(0, X);
  sv2.applyGate(1, X);
  sv2.applyControlledGate([0, 1], 2, CX_MATRIX);
  assert.equal(sv2.probabilities()[0b111], 1);
});

test("量子ビット番号はリトルエンディアン (qubit q = bit q)", () => {
  const sv = new StateVector(3);
  sv.applyGate(2, X);
  assert.equal(sv.probabilities()[0b100], 1);
});

test("範囲外の量子ビット指定は例外", () => {
  const sv = new StateVector(2);
  assert.throws(() => sv.applyGate(2, X), RangeError);
  assert.throws(() => sv.applyGate(-1, X), RangeError);
});

test("22量子ビット超はメモリ保護のため拒否", () => {
  assert.throws(() => new StateVector(23), RangeError);
});

test("測定サンプルは確率分布に収束する", () => {
  const sv = new StateVector(2);
  sv.applyGate(0, H);
  sv.applyControlledGate([0], 1, CX_MATRIX);
  const counts = sv.sample(20000, mulberry32(5));
  assert.ok(Math.abs(counts[0b00] / 20000 - 0.5) < 0.02);
  assert.ok(Math.abs(counts[0b11] / 20000 - 0.5) < 0.02);
  assert.equal(counts[0b01], 0);
  assert.equal(counts[0b10], 0);
});

test("同じシードなら測定結果は完全に再現する", () => {
  const make = () => {
    const sv = new StateVector(3);
    sv.applyGate(0, H);
    sv.applyGate(1, H);
    return sv.sample(500, mulberry32(99));
  };
  assert.deepEqual(Array.from(make()), Array.from(make()));
});

test("回路の逆回路を続けて実行すると初期状態に戻る", () => {
  const c = new Circuit(3);
  c.gate("h", 0).gate("ry", 1, [0.7]).cgate("x", [0], 2).gate("rz", 2, [1.1]);
  c.gate("t", 1).gate("s", 0);

  const sv = new StateVector(3);
  c.run(sv);
  assert.ok(sv.probabilities()[0] < 0.999, "何か起きていること");
  c.inverse().run(sv);
  assert.ok(Math.abs(sv.probabilities()[0] - 1) < 1e-13);
});

test("逆回路が定義できない命令は例外を投げる (黙って壊さない)", () => {
  const c = new Circuit(1);
  c.fused({
    name: "no-inverse",
    qubits: [0],
    apply: () => {},
    expand: () => [],
  });
  assert.throws(() => c.inverse(), /no defined inverse/);
});

test("自己逆なオラクルは逆回路でそのまま使い回される", () => {
  const c = new Circuit(2);
  c.opaque({
    name: "flip",
    qubits: [0, 1],
    selfInverse: true,
    apply: (sv) => sv.applyPhaseFlip((b) => b === 3),
    estimate: { gates1q: 1, gates2q: 1, depth: 2 },
    note: "テスト用",
  });
  assert.doesNotThrow(() => c.inverse());
});

test("resource 見積り: 標準ゲートは 1q/2q に分類される", () => {
  const c = new Circuit(2);
  c.gate("h", 0).gate("h", 1).cgate("x", [0], 1);
  const est = c.estimate();
  assert.equal(est.qubits, 2);
  assert.equal(est.gates1q, 2 + 3); // H×2 + 制御ゲート分解の 1q
  assert.equal(est.gates2q, 2);
  assert.ok(est.depth > 0);
});

test("OpenQASM3 出力: 標準ゲートのみなら complete", () => {
  const c = new Circuit(2);
  c.gate("h", 0).cgate("x", [0], 1);
  const { source, complete } = c.toQasm3();
  assert.equal(complete, true);
  assert.match(source, /OPENQASM 3\.0;/);
  assert.match(source, /qubit\[2\] q;/);
  assert.match(source, /ctrl\(1\) @ x q\[0\], q\[1\];/);
});

test("OpenQASM3 出力: 不透明命令があれば incomplete としてマークされる", () => {
  const c = new Circuit(1);
  c.opaque({
    name: "mystery",
    qubits: [0],
    apply: () => {},
    estimate: { gates1q: 0, gates2q: 5, depth: 3 },
    note: "分解未実装",
  });
  const { source, complete } = c.toQasm3();
  assert.equal(complete, false, "実機に投げられないことが分かること");
  assert.match(source, /OPAQUE mystery/);
});
