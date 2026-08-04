import test from "node:test";
import assert from "node:assert/strict";

import { computeMomentum, logReturns } from "../src/engine/momentum.ts";
import { bars, trendingCloses } from "./helpers.ts";

test("logReturns: n 本のバーから n-1 本のリターン", () => {
  const r = logReturns(bars([100, 110, 121]));
  assert.equal(r.length, 2);
  assert.ok(Math.abs(r[0] - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(r[1] - Math.log(1.1)) < 1e-12);
});

test("logReturns: バーが 1 本以下なら空", () => {
  assert.deepEqual(logReturns([]), []);
  assert.deepEqual(logReturns(bars([100])), []);
});

test("logReturns: 非正の終値をまたぐ区間は捨てる", () => {
  // Yahoo / Stooq は欠損を 0 や null で返すことがある。
  // log(0) = -Infinity をそのまま流すと下流が全部壊れる。
  const r = logReturns(bars([100, 0, 110, 121]));
  assert.equal(r.length, 1, "0 をまたぐ 2 区間は落ちる");
  assert.ok(Number.isFinite(r[0]));

  for (const v of logReturns(bars([100, -5, 110]))) {
    assert.ok(Number.isFinite(v));
  }
});

test("computeMomentum: 一定価格ならリターンもボラも 0", () => {
  const m = computeMomentum(bars(Array.from({ length: 120 }, () => 100)));
  assert.equal(m.r1w, 0);
  assert.equal(m.r1m, 0);
  assert.equal(m.r3m, 0);
  assert.equal(m.volAdj, 0, "ボラ 0 でのゼロ除算を踏んでいない");
  assert.equal(m.trendConsistency, 0, "上昇日ゼロ");
});

test("computeMomentum: 期間に満たないバー数ではリターン 0", () => {
  // 上場直後や長期休場明けに起きる。0 を返すのが仕様。
  const m = computeMomentum(bars(trendingCloses(4)));
  assert.equal(m.r1w, 0);
  assert.equal(m.r1m, 0);
  assert.equal(m.r3m, 0);
});

test("computeMomentum: 単調上昇では全期間のリターンが正で、長期ほど大きい", () => {
  const m = computeMomentum(bars(trendingCloses(200, 100, 0.002)));
  assert.ok(m.r1w > 0);
  assert.ok(m.r1m > m.r1w, "1ヶ月 > 1週間");
  assert.ok(m.r3m > m.r1m, "3ヶ月 > 1ヶ月");
  assert.equal(m.trendConsistency, 1, "全日上昇");
});

test("computeMomentum: 単調下落では全期間のリターンが負", () => {
  const m = computeMomentum(bars(trendingCloses(200, 100, -0.002)));
  assert.ok(m.r1w < 0);
  assert.ok(m.r1m < 0);
  assert.ok(m.r3m < 0);
  assert.equal(m.trendConsistency, 0);
});

test("computeMomentum: r1w / r1m / r3m は 5 / 21 / 63 営業日前との比", () => {
  const closes = trendingCloses(200, 100, 0.002);
  const m = computeMomentum(bars(closes));
  const last = closes[closes.length - 1];
  const expect = (d: number) => last / closes[closes.length - 1 - d] - 1;

  assert.ok(Math.abs(m.r1w - expect(5)) < 1e-12);
  assert.ok(Math.abs(m.r1m - expect(21)) < 1e-12);
  assert.ok(Math.abs(m.r3m - expect(63)) < 1e-12);
});

test("computeMomentum: trendConsistency は [0,1]", () => {
  const closes: number[] = [];
  let c = 100;
  for (let i = 0; i < 200; i++) {
    closes.push(c);
    c *= i % 3 === 0 ? 1.01 : 0.995;
  }
  const m = computeMomentum(bars(closes));
  assert.ok(m.trendConsistency >= 0 && m.trendConsistency <= 1);
});

test("computeMomentum: 全フィールドが有限値", () => {
  for (const n of [0, 1, 5, 22, 64, 200]) {
    const m = computeMomentum(bars(trendingCloses(n)));
    for (const [k, v] of Object.entries(m)) {
      assert.ok(Number.isFinite(v), `n=${n}: ${k}=${v} が有限でない`);
    }
  }
});
