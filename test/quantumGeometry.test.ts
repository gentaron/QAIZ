import test from "node:test";
import assert from "node:assert/strict";

import {
  amplitudeEncode,
  amplitudeEntropy,
  computeQuantumGeometry,
  fidelity,
  fubiniStudyDistance,
  qfiProxy,
} from "../src/engine/quantumGeometry.ts";
import { whiteNoise } from "./helpers.ts";

test("amplitudeEncode は単位ベクトルを返す", () => {
  const psi = amplitudeEncode([3, 4]);
  assert.ok(Math.abs(psi[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(psi[1] - 0.8) < 1e-9);

  const norm = psi.reduce((s, a) => s + a * a, 0);
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("amplitudeEncode は符号を位相として保持する", () => {
  const psi = amplitudeEncode([-3, 4]);
  assert.ok(psi[0] < 0, "下落日の振幅は負のまま残る");
  assert.ok(psi[1] > 0);
});

test("amplitudeEncode は空配列でも NaN を出さない (eps による保護)", () => {
  assert.deepEqual(amplitudeEncode([]), []);
  // 全ゼロ = 無変動の窓。実データでは連休や取引停止で普通に起きる。
  for (const a of amplitudeEncode([0, 0, 0])) {
    assert.ok(Number.isFinite(a));
    assert.equal(a, 0);
  }
});

test("fidelity: 同一状態は 1、直交状態は 0", () => {
  const psi = amplitudeEncode([1, 2, 3]);
  assert.ok(Math.abs(fidelity(psi, psi) - 1) < 1e-12);
  assert.equal(fidelity([1, 0], [0, 1]), 0);
});

test("fidelity: 符号反転は同一視される (射影ヒルベルト空間の点として同じ)", () => {
  const psi = amplitudeEncode([1, 2, 3]);
  const neg = psi.map((a) => -a);
  assert.ok(Math.abs(fidelity(psi, neg) - 1) < 1e-12);
});

test("fidelity は [0,1] に収まる", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const a = amplitudeEncode(whiteNoise(20, seed));
    const b = amplitudeEncode(whiteNoise(20, seed + 100));
    const F = fidelity(a, b);
    assert.ok(F >= 0 && F <= 1, `F=${F} が [0,1] の外`);
  }
});

test("fubiniStudyDistance は [0, π/2] の測地距離", () => {
  assert.equal(fubiniStudyDistance(1), 0);
  assert.ok(Math.abs(fubiniStudyDistance(0) - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(fubiniStudyDistance(0.5) - Math.PI / 4) < 1e-12);
});

test("fubiniStudyDistance は定義域外の F をクランプして NaN を出さない", () => {
  // 浮動小数の誤差で F が 1 をわずかに超える / 0 を下回ることがある。
  // acos が NaN を返すとヒートスコア全体が NaN で伝播する。
  assert.equal(fubiniStudyDistance(1.0000000001), 0);
  assert.ok(Math.abs(fubiniStudyDistance(-0.1) - Math.PI / 2) < 1e-12);
});

test("qfiProxy: 系列が短いと 0", () => {
  assert.equal(qfiProxy(whiteNoise(21), 20), 0);
  assert.equal(qfiProxy([], 20), 0);
});

test("qfiProxy: 定数列 (無変動) では 0", () => {
  const flat = Array.from({ length: 30 }, () => 0.001);
  assert.ok(Math.abs(qfiProxy(flat, 20)) < 1e-12);
});

test("qfiProxy は非負", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const v = qfiProxy(whiteNoise(60, seed), 20);
    assert.ok(v >= 0, `qfiProxy=${v} が負`);
    assert.ok(Number.isFinite(v));
  }
});

test("amplitudeEntropy: 一様分布で 1、一点集中で 0", () => {
  const uniform = Array.from({ length: 8 }, () => 0.01);
  // 許容誤差が 1e-6 なのは amplitudeEncode の norm に足している eps=1e-12 のため。
  // 小さな系列だと相対誤差が ~1e-9 まで乗るので、厳密一致では固定できない。
  assert.ok(Math.abs(amplitudeEntropy(uniform) - 1) < 1e-6);

  assert.ok(Math.abs(amplitudeEntropy([1, 0, 0, 0])) < 1e-6);
});

test("amplitudeEntropy: 1 要素では 0 (hMax=0 のゼロ除算を踏まない)", () => {
  assert.equal(amplitudeEntropy([5]), 0);
});

test("amplitudeEntropy は [0,1]", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const h = amplitudeEntropy(whiteNoise(40, seed));
    assert.ok(h >= 0 && h <= 1, `entropy=${h} が [0,1] の外`);
  }
});

test("computeQuantumGeometry: 窓 2 本ぶんに満たない系列は中立値を返す", () => {
  const g = computeQuantumGeometry(whiteNoise(39), 20);
  assert.deepEqual(g, { fidelity: 1, fubiniStudy: 0, qfiProxy: 0, entropy: 0 });
});

test("computeQuantumGeometry: 全指標が定義域に収まる", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = computeQuantumGeometry(whiteNoise(120, seed), 20);
    assert.ok(g.fidelity >= 0 && g.fidelity <= 1, "fidelity");
    assert.ok(g.fubiniStudy >= 0 && g.fubiniStudy <= Math.PI / 2, "fubiniStudy");
    assert.ok(g.qfiProxy >= 0, "qfiProxy");
    assert.ok(g.entropy >= 0 && g.entropy <= 1, "entropy");
  }
});

test("computeQuantumGeometry: fidelity と fubiniStudy は整合する", () => {
  const g = computeQuantumGeometry(whiteNoise(120, 7), 20);
  assert.ok(
    Math.abs(g.fubiniStudy - Math.acos(Math.sqrt(g.fidelity))) < 1e-12,
    "d_FS = arccos(√F) が崩れている"
  );
});

test("computeQuantumGeometry は決定論的", () => {
  const returns = whiteNoise(120, 42);
  assert.deepEqual(
    computeQuantumGeometry(returns, 20),
    computeQuantumGeometry(returns, 20)
  );
});
