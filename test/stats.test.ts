import test from "node:test";
import assert from "node:assert/strict";
import {
  clamp,
  correlation,
  isNum,
  kurtosis,
  linreg,
  mad,
  mean,
  median,
  percentileRanks,
  quantile,
  skewness,
  smaSeries,
  stdev,
  variance,
  weightedMean,
  winsorize,
  zToScore,
  zscores,
} from "../src/analytics/stats.ts";

test("欠損は 0 に潰されず null のまま残る", () => {
  assert.equal(mean([]), null);
  assert.equal(variance([1]), null);
  assert.equal(stdev([1]), null);
  assert.equal(median([]), null);
  // isNum は NaN / Infinity を弾く
  assert.equal(isNum(NaN), false);
  assert.equal(isNum(Infinity), false);
  assert.equal(isNum(0), true);
});

test("標本分散・標準偏差は n-1 で割る", () => {
  const xs = [2, 4, 4, 4, 5, 5, 7, 9];
  // 母分散 4 に対し標本分散は 32/7
  assert.ok(Math.abs(variance(xs)! - 32 / 7) < 1e-12);
  assert.ok(Math.abs(stdev(xs)! - Math.sqrt(32 / 7)) < 1e-12);
});

test("分位点は R type-7 の線形補間", () => {
  const xs = [1, 2, 3, 4];
  assert.equal(quantile(xs, 0), 1);
  assert.equal(quantile(xs, 1), 4);
  assert.equal(quantile(xs, 0.5), 2.5);
  // pos = 0.25 * 3 = 0.75 → 1 + 0.75*(2-1) = 1.75
  assert.ok(Math.abs(quantile(xs, 0.25)! - 1.75) < 1e-12);
  // ソートされていない入力でも同じ結果
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
});

test("MAD は外れ値に引きずられない", () => {
  const clean = [1, 2, 3, 4, 5];
  const dirty = [1, 2, 3, 4, 1000];
  assert.equal(mad(clean), mad(dirty));
  // 一方で標準偏差は壊滅的に動く
  assert.ok(stdev(dirty)! > stdev(clean)! * 50);
});

test("ウィンザライズは分布の端を刈り込む", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
  const w = winsorize(xs, 0.1);
  assert.ok(Math.max(...w) < 1000);
  assert.equal(w.length, xs.length);
  // 中央付近の値は変わらない
  assert.equal(w[4], 5);
});

test("Zスコアは欠損を欠損のまま返す (0 で埋めない)", () => {
  const z = zscores([1, 2, 3, null, 5]);
  assert.equal(z[3], null);
  assert.equal(z.filter((x) => x !== null).length, 4);
  // 平均より上は正、下は負
  assert.ok(z[0]! < 0);
  assert.ok(z[4]! > 0);
});

test("Zスコアはサンプルが 3 未満なら計算しない", () => {
  assert.deepEqual(zscores([1, 2]), [null, null]);
});

test("パーセンタイル順位は同値に平均順位を配る", () => {
  const p = percentileRanks([10, 20, 20, 30]);
  assert.equal(p[0], 0);
  assert.equal(p[3], 100);
  // 20 が 2 つ → 順位 1,2 の平均 1.5 → 1.5/3*100 = 50
  assert.equal(p[1], 50);
  assert.equal(p[2], 50);
});

test("相関: 完全一致は 1、符号反転は -1", () => {
  const a = [1, 2, 3, 4, 5, 6];
  assert.ok(Math.abs(correlation(a, a)! - 1) < 1e-12);
  assert.ok(Math.abs(correlation(a, a.map((x) => -x))! + 1) < 1e-12);
  // 定数列は相関が定義できない
  assert.equal(correlation(a, [1, 1, 1, 1, 1, 1]), null);
});

test("単回帰は傾き・切片・R²を正しく返す", () => {
  const x = [1, 2, 3, 4, 5];
  const y = x.map((v) => 3 * v + 2);
  const r = linreg(x, y)!;
  assert.ok(Math.abs(r.beta - 3) < 1e-10);
  assert.ok(Math.abs(r.alpha - 2) < 1e-10);
  assert.ok(Math.abs(r.r2 - 1) < 1e-10);
});

test("歪度・尖度: 対称分布は歪度 0", () => {
  const sym = [-3, -2, -1, 0, 1, 2, 3];
  assert.ok(Math.abs(skewness(sym)!) < 1e-12);
  // 右に長い裾を足すと正の歪度になる
  assert.ok(skewness([...sym, 20])! > 0);
  assert.ok(kurtosis([...sym, 20])! > kurtosis(sym)!);
});

test("移動平均は窓に満たない先頭を null にする", () => {
  const s = smaSeries([1, 2, 3, 4, 5], 3);
  assert.deepEqual(s.slice(0, 2), [null, null]);
  assert.equal(s[2], 2);
  assert.equal(s[4], 4);
});

test("加重平均は欠損分のウェイトを外して再正規化する", () => {
  const r = weightedMean([
    { value: 10, weight: 1 },
    { value: null, weight: 3 },
    { value: 20, weight: 1 },
  ]);
  assert.equal(r.value, 15);
  assert.equal(r.usedWeight, 2);
  assert.equal(weightedMean([{ value: null, weight: 1 }]).value, null);
});

test("Zスコア→スコア変換は ±2.5σ で飽和する", () => {
  assert.equal(zToScore(0), 50);
  assert.equal(zToScore(2.5), 100);
  assert.equal(zToScore(-2.5), 0);
  assert.equal(zToScore(10), 100);
  assert.equal(zToScore(null), null);
});

test("clamp は範囲外を丸める", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});
