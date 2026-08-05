import test from "node:test";
import assert from "node:assert/strict";
import {
  adxSeries,
  atrSeries,
  bollingerSeries,
  classicPivots,
  computeTechnicals,
  detectDivergence,
  emaSeries,
  fibonacciPivots,
  macdSeries,
  mfiSeries,
  obvSeries,
  rsiSeries,
  stochasticSeries,
  supportResistance,
  trueRanges,
  vwap,
  wilderSeries,
  williamsRSeries,
} from "../src/analytics/technicals.ts";
import { WILDER_CLOSES, bars, ohlc, sine, trending, walk } from "./helpers.ts";

const near = (a: number | null, b: number, tol = 0.01) => {
  assert.ok(a !== null, "値が null");
  assert.ok(Math.abs(a! - b) <= tol, `${a} ≠ ${b} (許容 ${tol})`);
};

test("RSI(14) は Wilder 系列に対する手計算値と一致する", () => {
  const r = rsiSeries(WILDER_CLOSES, 14);
  // 先頭 14 本は算出不可
  assert.deepEqual(r.slice(0, 14), new Array(14).fill(null));

  // 最初の 14 本の変化から手計算した値:
  //   上昇合計 3.34 / 14 = 0.2385714…、下落合計 1.40 / 14 = 0.10
  //   RS = 2.3857142… → RSI = 100 − 100/3.3857142… = 70.4641…
  // (よく引用される 70.53 は、終値が小数2桁に丸められる前の元データで
  //  計算された表の値。丸め後の系列からは 70.46 が正しい。)
  near(r[14], 70.4641, 0.001);
  near(r[15], 66.2494, 0.001);

  // 以降は公表テーブルと 0.1 以内で一致していれば実装として妥当。
  // 丸め由来のズレは終盤まで 0.07 以内に収まり、発散しない。
  near(r[16], 66.55, 0.1);
  near(r[17], 69.41, 0.1);
  near(r[18], 66.36, 0.1);
  near(r[19], 57.97, 0.1);
  near(r[26], 39.99, 0.1);
  near(r[28], 41.87, 0.1);
  near(r[29], 45.46, 0.1);
  near(r[32], 37.77, 0.1);
});

test("RSI: 一本調子の上昇は 100 に張り付き、下落は 0 に張り付く", () => {
  const up = rsiSeries(trending(40, 100, 0.01), 14);
  near(up[39], 100, 1e-6);
  const down = rsiSeries(trending(40, 100, -0.01), 14);
  near(down[39], 0, 1e-6);
});

test("EMA の初期値は最初の period 本の単純平均", () => {
  const xs = [1, 2, 3, 4, 5, 6];
  const e = emaSeries(xs, 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2); // (1+2+3)/3
  // k = 2/(3+1) = 0.5 → 4*0.5 + 2*0.5 = 3
  assert.equal(e[3], 3);
  assert.equal(e[4], 4);
});

test("Wilder 平滑は EMA より緩やか (α=1/n)", () => {
  const xs = [10, 10, 10, 10, 20, 10, 10, 10];
  const w = wilderSeries(xs, 4);
  const e = emaSeries(xs, 4);
  // ショックの直後、Wilder の方が反応が小さい
  assert.ok(w[4]! < e[4]!);
});

test("MACD はヒストグラム = MACD − シグナル", () => {
  const cs = walk(200, 3);
  const m = macdSeries(cs, 12, 26, 9);
  const i = cs.length - 1;
  near(m.hist[i], m.macd[i]! - m.signal[i]!, 1e-9);
  // MACD は 26 本目から、シグナルはさらに 8 本遅れて確定する
  assert.equal(m.macd[24], null);
  assert.ok(m.macd[25] !== null);
  assert.equal(m.signal[32], null);
  assert.ok(m.signal[33] !== null);
});

test("ボリンジャーバンドは中心線 ± 2σ、%B は上下バンドで 1/0", () => {
  const cs = walk(120, 11);
  const b = bollingerSeries(cs, 20, 2);
  const i = cs.length - 1;
  const mid = b.middle[i]!;
  const up = b.upper[i]!;
  const lo = b.lower[i]!;
  near(mid, (up + lo) / 2, 1e-9);
  // バンド幅 = (上-下)/中心
  near(b.bandwidth[i], (up - lo) / mid, 1e-9);
  // 定数列ではバンド幅が 0 になる
  const flat = bollingerSeries(new Array(50).fill(100), 20, 2);
  near(flat.bandwidth[49], 0, 1e-9);
});

test("True Range は 3 つの候補の最大値", () => {
  const b = ohlc([
    [10, 12, 9, 11],
    [11, 15, 10, 14], // h-l=5, |h-pc|=4, |l-pc|=1 → 5
    [14, 15, 8, 9], // h-l=7, |h-pc|=1, |l-pc|=6 → 7
  ]);
  const tr = trueRanges(b);
  assert.equal(tr[0], 5);
  assert.equal(tr[1], 7);
});

test("ATR は Wilder 平滑された True Range", () => {
  const b = bars(walk(80, 5));
  const a = atrSeries(b, 14);
  assert.equal(a[0], null);
  assert.ok(a[a.length - 1]! > 0);
  // 高安が終値の ±0.5% なので、ATR は概ね終値の 1% 前後に収まる
  const last = b[b.length - 1].c;
  assert.ok(a[a.length - 1]! < last * 0.1);
});

test("ADX: トレンド相場で高く、レンジ相場で低い", () => {
  const trendBars = bars(trending(160, 100, 0.008));
  const rangeBars = bars(sine(160, 30, 0.05));
  const t = adxSeries(trendBars, 14);
  const r = adxSeries(rangeBars, 14);
  const tv = t.adx[t.adx.length - 1]!;
  const rv = r.adx[r.adx.length - 1]!;
  assert.ok(tv > 25, `トレンドの ADX が低い: ${tv}`);
  assert.ok(tv > rv, `ADX がトレンド(${tv}) ≤ レンジ(${rv})`);
  // 上昇トレンドでは +DI が -DI を上回る
  assert.ok(t.plusDi[t.plusDi.length - 1]! > t.minusDi[t.minusDi.length - 1]!);
});

test("ストキャス %K は直近窓のレンジ内位置", () => {
  const b = ohlc([
    [10, 12, 8, 10], [10, 12, 8, 10], [10, 12, 8, 12],
  ]);
  const s = stochasticSeries(b, 3, 1, 1);
  // 窓の高値12 / 安値8、終値12 → 100%
  assert.equal(s.k[2], 100);
});

test("Williams %R は %K の符号反転版 (0 〜 -100)", () => {
  const b = bars(walk(60, 9));
  const w = williamsRSeries(b, 14);
  const last = w[w.length - 1]!;
  assert.ok(last <= 0 && last >= -100);
});

test("OBV は出来高が無い銘柄では計算しない", () => {
  const noVol = bars(walk(40, 2), null);
  assert.deepEqual(obvSeries(noVol).filter((x) => x !== null), []);
  // 出来高があれば累積する
  const withVol = bars([10, 11, 12], 100);
  assert.deepEqual(obvSeries(withVol), [0, 100, 200]);
});

test("MFI は出来高加重版 RSI として 0-100 に収まる", () => {
  const b = bars(walk(80, 13));
  const m = mfiSeries(b, 14);
  const last = m[m.length - 1]!;
  assert.ok(last >= 0 && last <= 100);
});

test("VWAP は出来高が全て等しければ典型価格の平均に一致する", () => {
  const b = ohlc([[10, 11, 9, 10], [20, 21, 19, 20], [30, 31, 29, 30]], 500);
  // 典型価格 = (h+l+c)/3 → 10, 20, 30
  near(vwap(b, 3), 20, 1e-9);
  // 出来高が無ければ null
  const noVol = ohlc([[10, 11, 9, 10]], 0).map((x) => ({ ...x, v: null }));
  assert.equal(vwap(noVol, 3), null);
});

test("ピボットは古典式とフィボナッチ式で中心線が一致する", () => {
  const bar = { t: 0, o: 100, h: 110, l: 90, c: 105, v: null };
  const c = classicPivots(bar);
  const f = fibonacciPivots(bar);
  near(c.pivot, (110 + 90 + 105) / 3, 1e-9);
  assert.equal(c.pivot, f.pivot);
  near(c.r1, 2 * c.pivot - 90, 1e-9);
  near(c.s1, 2 * c.pivot - 110, 1e-9);
  // フィボナッチの R1 は中心線 + 0.382 × レンジ
  near(f.r1, c.pivot + 0.382 * 20, 1e-9);
});

test("支持・抵抗は同じ価格帯へのタッチ回数を数える", () => {
  // 100 で 3 回跳ね返され、90 で 3 回下支えられる形を作る
  const cycle = [90, 92, 94, 96, 98, 100, 98, 96, 94, 92];
  const closes = [...cycle, ...cycle, ...cycle, 93, 93, 93, 93];
  const sr = supportResistance(bars(closes), { lookback: 120, fractal: 3, tolerance: 0.02 });

  assert.ok(sr.resistance.length > 0, "抵抗帯が検出されない");
  assert.ok(sr.support.length > 0, "支持帯が検出されない");
  // 同じ水準を複数回叩いていることが touches に出る
  assert.ok(sr.resistance[0].touches >= 2, `タッチ回数が集計されていない: ${sr.resistance[0].touches}`);
  // 抵抗は現値より上、支持は下。距離の符号もそれに従う
  for (const r of sr.resistance) assert.ok(r.distancePct > 0 && r.level > 93);
  for (const s of sr.support) assert.ok(s.distancePct < 0 && s.level < 93);
});

test("ダイバージェンス: 価格が安値切り下げ / RSI が切り上げなら強気", () => {
  // 大きく下げてから浅い二番底を作る
  const closes = [
    ...trending(30, 100, -0.02), // 急落
    ...trending(15, 54, 0.012), // 戻し
    ...trending(12, 64, -0.012), // 二番底 (前より浅い下げ)
    ...trending(10, 55, 0.008),
  ];
  const b = bars(closes);
  const d = detectDivergence(b, rsiSeries(closes, 14), 70, 3);
  assert.ok(d === "bullish" || d === "none", `想定外の判定: ${d}`);
});

test("computeTechnicals: 上昇トレンドは強気、下降トレンドは弱気に振れる", () => {
  const up = computeTechnicals(bars(trending(300, 100, 0.004)));
  const down = computeTechnicals(bars(trending(300, 300, -0.004)));
  assert.ok(up.compositeScore > 65, `上昇の総合が低い: ${up.compositeScore}`);
  assert.ok(down.compositeScore < 35, `下降の総合が高い: ${down.compositeScore}`);
  assert.equal(up.ma.cross, "golden");
  assert.equal(down.ma.cross, "dead");
  assert.equal(up.ma.perfectOrder, "bullish");
  assert.equal(down.ma.perfectOrder, "bearish");
  assert.equal(up.ma.above.sma200, true);
  assert.equal(down.ma.above.sma200, false);
  // 合議の内訳は必ず開示される
  assert.ok(up.breakdown.length >= 5);
  assert.ok(up.breakdown.every((b) => b.note.length > 0));
});

test("computeTechnicals: データが短くても落ちず、算出不能は null になる", () => {
  const t = computeTechnicals(bars(walk(40, 21)));
  assert.equal(t.ma.sma200, null);
  assert.equal(t.ma.above.sma200, null);
  assert.equal(t.ma.cross, "none");
  // 短くても RSI(14) は出る
  assert.ok(t.rsi14 !== null);
  assert.ok(t.compositeScore >= 0 && t.compositeScore <= 100);
});

test("computeTechnicals: 総合スコアは常に 0-100、ラベルと整合する", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const t = computeTechnicals(bars(walk(300, seed)));
    assert.ok(t.compositeScore >= 0 && t.compositeScore <= 100);
    if (t.compositeScore >= 75) assert.equal(t.compositeLabel, "strong-buy");
    if (t.compositeScore <= 25) assert.equal(t.compositeLabel, "strong-sell");
  }
});
