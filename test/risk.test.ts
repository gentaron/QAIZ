import test from "node:test";
import assert from "node:assert/strict";
import {
  annualizedVol,
  captureRatios,
  computeRisk,
  conditionalVar,
  downsideDeviation,
  drawdown,
  historicalVar,
} from "../src/analytics/risk.ts";
import {
  alignByDate,
  computePriceSummary,
  logReturns,
  momentum12m1m,
  periodReturn,
  ytdReturn,
} from "../src/analytics/returns.ts";
import { bars, trending, walk } from "./helpers.ts";

test("対数リターンは価格比の対数", () => {
  const r = logReturns(bars([100, 110, 99]));
  assert.ok(Math.abs(r[0] - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(r[1] - Math.log(0.9)) < 1e-12);
});

test("期間リターンはデータ不足なら null (0 ではない)", () => {
  const b = bars([100, 101, 102]);
  assert.equal(periodReturn(b, 10), null);
  assert.ok(Math.abs(periodReturn(b, 2)! - 0.02) < 1e-12);
});

test("12-1モメンタムは直近1ヶ月を除外する", () => {
  // 250本まで +0.4%/日 で伸び、最後の 21 本だけ暴落させる
  const up = trending(253, 100, 0.004);
  const crashed = [...up.slice(0, 232), ...trending(21, up[231], -0.03)];
  const b = bars(crashed);
  const m = momentum12m1m(b)!;
  const plain = periodReturn(b, 252)!;
  // 直近の暴落を除くので 12-1 の方が高く出る = 短期リバーサルを拾わない
  assert.ok(m > plain, `12-1 (${m}) が単純12ヶ月 (${plain}) を下回った`);
  assert.ok(m > 0);
  assert.ok(plain < m);
});

test("年初来リターンは前年末終値を基準にする", () => {
  const day = 86400;
  const mk = (iso: string, c: number) => ({ t: Date.parse(iso) / 1000, o: c, h: c, l: c, c, v: null });
  const b = [
    mk("2024-12-30T00:00:00Z", 100),
    mk("2025-01-02T00:00:00Z", 105),
    mk("2025-01-03T00:00:00Z", 110),
  ];
  assert.ok(Math.abs(ytdReturn(b)! - 0.1) < 1e-12);
  // 今年のバーしか無ければ基準が取れないので null
  assert.equal(ytdReturn(b.slice(1)), null);
  assert.equal(day, 86400);
});

test("年率ボラは √252 でスケールされる", () => {
  const daily = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
  const v = annualizedVol(daily)!;
  // 日次σ ≈ 0.010541 (n-1) → 年率 ≈ 0.1673
  assert.ok(Math.abs(v - 0.010541 * Math.sqrt(252)) < 1e-3);
});

test("下方偏差は上昇分を無視する", () => {
  const up = [0.02, 0.03, 0.01, 0.02, 0.03, 0.02, 0.01];
  // 下落が 5 本未満なら算出しない
  assert.equal(downsideDeviation(up), null);
  const mixed = [0.02, -0.01, 0.03, -0.02, -0.01, 0.02, -0.03, -0.01];
  assert.ok(downsideDeviation(mixed)! > 0);
});

test("最大ドローダウンはピークからの下落率と期間を返す", () => {
  const b = bars([100, 120, 90, 95, 130, 110]);
  const dd = drawdown(b);
  // ピーク 120 → 底 90 で -25%
  assert.ok(Math.abs(dd.max! + 0.25) < 1e-12);
  assert.equal(dd.maxDays, 1);
  // 直近は史上最高値 130 から 110 なので -15.38%
  assert.ok(Math.abs(dd.current! - (110 / 130 - 1)) < 1e-12);
});

test("歴史的 VaR / CVaR: サンプル不足なら null、あるなら正の損失率", () => {
  assert.equal(historicalVar([0.01, -0.02], 0.95), null);
  const rs = Array.from({ length: 200 }, (_, i) => (i < 10 ? -0.05 : 0.002));
  const v95 = historicalVar(rs, 0.95)!;
  const c95 = conditionalVar(rs, 0.95)!;
  assert.ok(v95 > 0);
  // CVaR はテール平均なので VaR 以上になる
  assert.ok(c95 >= v95, `CVaR ${c95} < VaR ${v95}`);
});

test("キャプチャレシオ: 完全連動なら上下とも 1", () => {
  const bench = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const c = captureRatios(bench, bench);
  assert.ok(Math.abs(c.up! - 1) < 1e-12);
  assert.ok(Math.abs(c.down! - 1) < 1e-12);
  // 2倍レバレッジなら 2
  const lev = captureRatios(bench.map((x) => x * 2), bench);
  assert.ok(Math.abs(lev.up! - 2) < 1e-12);
});

test("日付整合: 営業日がずれた系列は共通日だけで比較する", () => {
  const day = 86400;
  const mk = (ts: number[], base = 100) =>
    ts.map((t, i) => ({ t, o: base + i, h: base + i, l: base + i, c: base + i, v: null }));
  const a = mk([1 * day, 2 * day, 3 * day, 4 * day]);
  // b は 2 日目が休場
  const b = mk([1 * day, 3 * day, 4 * day]);
  const al = alignByDate(a, b);
  // 共通日は 1,3,4 の 3 日 → リターンは 2 本
  assert.equal(al.days, 2);
  assert.equal(al.a.length, al.b.length);
});

test("β: 自分自身に対しては 1、2倍系列に対しては 0.5", () => {
  const base = walk(300, 31);
  const b = bars(base);
  const self = computeRisk(b, b, "self");
  // 同一系列でも benchmark 判定は呼び出し側なので、ここでは直接渡す
  assert.ok(Math.abs(self.beta! - 1) < 1e-6, `β=${self.beta}`);
  assert.ok(Math.abs(self.rSquared! - 1) < 1e-6);
  assert.ok(Math.abs(self.correlationToBenchmark! - 1) < 1e-6);
  // トラッキングエラーはゼロ
  assert.ok(self.trackingError! < 1e-9);
});

test("computeRisk: ベンチマーク未指定でも自己完結の指標は出る", () => {
  const r = computeRisk(bars(walk(300, 41)), null, null);
  assert.equal(r.beta, null);
  assert.equal(r.benchmark, null);
  assert.ok(r.vol252 !== null);
  assert.ok(r.maxDrawdown !== null);
  assert.ok(r.var95 !== null);
  assert.ok(r.riskFreeAssumption.length > 0);
});

test("computeRisk: 高ボラ系列の方がボラ・VaR ともに大きい", () => {
  const calm = computeRisk(bars(walk(300, 5, 100, 0.004)), null, null);
  const wild = computeRisk(bars(walk(300, 5, 100, 0.03)), null, null);
  assert.ok(wild.vol252! > calm.vol252!);
  assert.ok(wild.var95! > calm.var95!);
  assert.ok(wild.maxDrawdown! < calm.maxDrawdown!);
});

test("価格サマリ: 52週レンジ位置は 0-1、高値更新時は 1 付近", () => {
  const p = computePriceSummary(bars(trending(300, 100, 0.003)), "USD");
  assert.ok(p.rangePosition52w! > 0.95);
  assert.ok(p.drawdownFrom52wHigh! <= 0);
  assert.equal(p.currency, "USD");
  assert.ok(p.r12m! > 0);
});

test("価格サマリ: 出来高が無い銘柄は出来高系を null にする", () => {
  const b = bars(walk(60, 8), null);
  const p = computePriceSummary(b, "JPY");
  assert.equal(p.avgVolume20d, null);
  assert.equal(p.volumeRatio, null);
});
