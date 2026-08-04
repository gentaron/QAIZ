import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCosmoSpectral,
  hurstExponent,
  spectralSlope,
} from "../src/engine/cosmology.ts";
import { meanReverting, persistent, whiteNoise } from "./helpers.ts";

test("hurstExponent: 32 点未満はランダムウォーク相当の 0.5 を返す", () => {
  assert.equal(hurstExponent(whiteNoise(31)), 0.5);
  assert.equal(hurstExponent([]), 0.5);
});

test("hurstExponent: 定数列では 0.5 (標準偏差 0 のゼロ除算を踏まない)", () => {
  // 実データでは値幅制限・取引停止・データ欠損の補完で発生する。
  const flat = Array.from({ length: 128 }, () => 0.002);
  assert.equal(hurstExponent(flat), 0.5);
});

test("hurstExponent は [0,1] にクランプされる", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const h = hurstExponent(whiteNoise(256, seed));
    assert.ok(h >= 0 && h <= 1, `H=${h} が [0,1] の外`);
    assert.ok(Number.isFinite(h));
  }
});

test("hurstExponent: 持続的な系列は平均回帰的な系列より大きい H を返す", () => {
  // これがスコアリングでの「レジーム係数」の前提。逆転したら
  // regimeGain がモメンタムを増幅すべきときに減衰させることになる。
  for (let seed = 1; seed <= 8; seed++) {
    const hp = hurstExponent(persistent(512, seed));
    const hm = hurstExponent(meanReverting(512, seed));
    assert.ok(
      hp > hm,
      `seed=${seed}: 持続 H=${hp.toFixed(3)} <= 平均回帰 H=${hm.toFixed(3)}`
    );
  }
});

test("hurstExponent: 平均回帰的な系列は 0.5 を下回る", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const h = hurstExponent(meanReverting(512, seed));
    assert.ok(h < 0.5, `seed=${seed}: H=${h.toFixed(3)} が 0.5 以上`);
  }
});

test("spectralSlope: 32 点未満は 0", () => {
  assert.equal(spectralSlope(whiteNoise(31)), 0);
  assert.equal(spectralSlope([]), 0);
});

test("spectralSlope: 定数列は 0 (パワーが全周波数でゼロ)", () => {
  const flat = Array.from({ length: 128 }, () => 0.002);
  assert.equal(spectralSlope(flat), 0);
});

test("spectralSlope: 白色ノイズの傾きは 0 付近", () => {
  // 白色ノイズはパワーが周波数に依存しない = log-log 回帰の傾きが 0。
  // 有限長のばらつきがあるので緩めに見る。
  for (let seed = 1; seed <= 8; seed++) {
    const s = spectralSlope(whiteNoise(128, seed));
    assert.ok(Math.abs(s) < 0.5, `seed=${seed}: slope=${s.toFixed(3)}`);
  }
});

test("spectralSlope: 低周波が支配的な系列は負の傾き (赤色ノイズ寄り)", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const s = spectralSlope(persistent(128, seed));
    assert.ok(s < 0, `seed=${seed}: slope=${s.toFixed(3)} が非負`);
  }
});

test("computeCosmoSpectral: spectralSlope は直近 120 点だけを見る", () => {
  const tail = whiteNoise(120, 3);
  // 先頭に別系列を足しても、直近 120 点が同じなら結果は変わらない。
  const withPrefix = [...whiteNoise(200, 99), ...tail];
  assert.equal(
    computeCosmoSpectral(withPrefix).spectralSlope,
    computeCosmoSpectral(tail).spectralSlope
  );
});

test("computeCosmoSpectral は決定論的で有限値を返す", () => {
  const returns = whiteNoise(256, 42);
  const a = computeCosmoSpectral(returns);
  const b = computeCosmoSpectral(returns);
  assert.deepEqual(a, b);
  assert.ok(Number.isFinite(a.hurst) && Number.isFinite(a.spectralSlope));
});
