import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterByCorrelation,
  correlationMatrix,
  principalComponent,
} from "../src/analytics/correlation.ts";
import { rotationPoint, cyclicalDefensiveSpread } from "../src/analytics/rotation.ts";
import { computeBreadth } from "../src/analytics/breadth.ts";
import { computeRegime } from "../src/analytics/regime.ts";
import { analyzeInstrument } from "../src/pipeline.ts";
import { UNIVERSE, getInstrument, sectorCells, shardUniverse } from "../src/config/universe.ts";
import { REGION_META, SECTOR_META } from "../src/config/sectors.ts";
import type { Instrument, InstrumentRecord, Series } from "../src/types.ts";
import { bars, sine, trending, walk } from "./helpers.ts";

const inst = (symbol: string, over: Partial<Instrument> = {}): Instrument => ({
  symbol, name: symbol, nameJa: symbol, region: "US", sector: "tech",
  assetClass: "etf", role: "sector-proxy", currency: "USD", ...over,
});

const series = (symbol: string, closes: number[]): Series => ({
  symbol, name: symbol, currency: "USD", bars: bars(closes), source: "yahoo",
  fetchedAt: "2026-08-05T00:00:00.000Z",
});

function record(symbol: string, closes: number[], over: Partial<Instrument> = {}): InstrumentRecord {
  return analyzeInstrument(inst(symbol, over), series(symbol, closes), null);
}

/* ---------------- ユニバース定義 ---------------- */

test("ユニバース: シンボルが重複していない", () => {
  const seen = new Set<string>();
  for (const i of UNIVERSE) {
    assert.ok(!seen.has(i.symbol), `重複シンボル: ${i.symbol}`);
    seen.add(i.symbol);
  }
  assert.ok(UNIVERSE.length > 100, `ユニバースが小さすぎる: ${UNIVERSE.length}`);
});

test("ユニバース: 全銘柄のセクター/地域がメタ定義に存在する", () => {
  for (const i of UNIVERSE) {
    assert.ok(SECTOR_META[i.sector], `未定義セクター: ${i.sector} (${i.symbol})`);
    assert.ok(REGION_META[i.region], `未定義地域: ${i.region} (${i.symbol})`);
  }
});

test("ユニバース: 各地域のベンチマークがユニバースに含まれる", () => {
  const regions = new Set(UNIVERSE.map((i) => i.region));
  for (const r of regions) {
    const bench = REGION_META[r].benchmark;
    assert.ok(getInstrument(bench), `${r} のベンチマーク ${bench} がユニバースに無い`);
  }
});

test("シャード分割: 全銘柄がちょうど 1 回ずつ現れる", () => {
  const shards = 8;
  const seen: string[] = [];
  for (let s = 0; s < shards; s++) seen.push(...shardUniverse(s, shards).map((i) => i.symbol));
  assert.equal(seen.length, UNIVERSE.length);
  assert.equal(new Set(seen).size, UNIVERSE.length);
});

test("シャード分割: どのシャードにも優先度の高い銘柄が混ざる", () => {
  const shards = 8;
  for (let s = 0; s < shards; s++) {
    const chunk = shardUniverse(s, shards);
    assert.ok(chunk.length > 0);
    const best = Math.min(...chunk.map((i) => i.priority ?? 5));
    assert.ok(best <= 2, `シャード ${s} に重要銘柄が無い (最良優先度 ${best})`);
  }
});

test("セクターセル: ベンチマークとマクロは集計対象から外れる", () => {
  const cells = sectorCells();
  const all = cells.flatMap((c) => c.members);
  assert.ok(all.every((m) => m.role !== "benchmark" && m.role !== "macro"));
  assert.ok(cells.some((c) => c.region === "US" && c.sector === "tech"));
});

/* ---------------- 市場の幅 ---------------- */

test("市場の幅: 上昇銘柄が多ければ broad-rally、少なければ selloff", () => {
  const up = Array.from({ length: 10 }, (_, i) => record(`U${i}`, trending(300, 100, 0.004)));
  const b = computeBreadth("テスト", up)!;
  assert.equal(b.count, 10);
  assert.equal(b.pctAbove200dma, 100);
  assert.equal(b.label, "broad-rally");

  const down = Array.from({ length: 10 }, (_, i) => record(`D${i}`, trending(300, 300, -0.004)));
  const bd = computeBreadth("テスト", down)!;
  assert.equal(bd.pctAbove200dma, 0);
  assert.equal(bd.label, "broad-selloff");
});

test("市場の幅: 3 銘柄未満なら判定しない", () => {
  assert.equal(computeBreadth("少数", [record("A", walk(300, 1))]), null);
});

/* ---------------- レジーム ---------------- */

test("レジーム: 上昇 + 低VIX + 信用スプレッド良好ならリスクオンの上昇基調", () => {
  const recs: Record<string, InstrumentRecord> = {
    "^GSPC": record("^GSPC", trending(300, 100, 0.004), { role: "benchmark", assetClass: "index", sector: "broad" }),
    "^VIX": record("^VIX", walk(300, 3, 13, 0.02), { role: "macro", assetClass: "index", sector: "macro" }),
    HYG: record("HYG", trending(300, 100, 0.001), { role: "macro", assetClass: "etf", sector: "macro" }),
    LQD: record("LQD", trending(300, 100, -0.0005), { role: "macro", assetClass: "etf", sector: "macro" }),
    "HG=F": record("HG=F", trending(300, 100, 0.002), { role: "macro", assetClass: "commodity", sector: "macro" }),
    "GC=F": record("GC=F", trending(300, 100, -0.001), { role: "macro", assetClass: "commodity", sector: "macro" }),
  };
  const breadth = computeBreadth("テスト", Object.values(recs));
  const r = computeRegime(recs, breadth)!;
  assert.equal(r.trend, "bull");
  assert.equal(r.riskAppetite, "risk-on");
  assert.ok(["low", "normal"].includes(r.volatility), `想定外のボラ判定: ${r.volatility}`);
  // 根拠とプレイブックが必ず付く
  assert.ok(r.evidence.length >= 4);
  assert.ok(r.playbook.length >= 1);
  assert.ok(r.evidence.every((e) => e.reading.length > 0));
});

test("レジーム: 下降 + 高VIX ならストレス下の下降基調", () => {
  const recs: Record<string, InstrumentRecord> = {
    "^GSPC": record("^GSPC", trending(300, 300, -0.004), { role: "benchmark", assetClass: "index", sector: "broad" }),
    "^VIX": record("^VIX", trending(300, 12, 0.004), { role: "macro", assetClass: "index", sector: "macro" }),
  };
  const r = computeRegime(recs, null)!;
  assert.equal(r.trend, "bear");
  assert.equal(r.volatility, "stress");
  assert.ok(r.playbook.some((p) => p.includes("現金") || p.includes("ディフェンシブ")));
});

test("レジーム: S&P500 が無ければ判定しない", () => {
  assert.equal(computeRegime({}, null), null);
});

/* ---------------- 相関・主成分 ---------------- */

test("主成分: 全ペア相関 1 の行列では第1主成分が全分散を説明する", () => {
  const n = 4;
  const m = new Array(n * n).fill(1);
  const pc = principalComponent(m, n);
  assert.ok(Math.abs(pc.share - 1) < 1e-6, `寄与率 ${pc.share}`);
  // ローディングは全て同符号・等しい大きさ
  for (const l of pc.loadings) assert.ok(Math.abs(Math.abs(l) - 0.5) < 1e-6);
});

test("主成分: 単位行列 (無相関) では寄与率が 1/n になる", () => {
  const n = 5;
  const m = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) m[i * n + i] = 1;
  const pc = principalComponent(m, n);
  assert.ok(Math.abs(pc.share - 1 / n) < 1e-6, `寄与率 ${pc.share}`);
});

test("クラスタリング: 相関の高い塊どうしがまとまる", () => {
  // 0,1 が高相関、2,3 が高相関、塊どうしは無相関
  const n = 4;
  const m = [
    1, 0.95, 0, 0,
    0.95, 1, 0, 0,
    0, 0, 1, 0.95,
    0, 0, 0.95, 1,
  ];
  const cl = clusterByCorrelation(m, n, ["A", "B", "C", "D"], 1.0);
  assert.equal(cl.length, 2);
  const sets = cl.map((c) => c.symbols.join(","));
  assert.ok(sets.includes("A,B"), `想定外のクラスタ: ${JSON.stringify(sets)}`);
  assert.ok(sets.includes("C,D"));
});

test("相関行列: 対角は 1、対称、平均ペア相関が計算される", () => {
  const inputs = [
    { symbol: "A", label: "A", bars: bars(walk(200, 1)) },
    { symbol: "B", label: "B", bars: bars(walk(200, 2)) },
    { symbol: "C", label: "C", bars: bars(walk(200, 3)) },
    { symbol: "D", label: "D", bars: bars(walk(200, 4)) },
  ];
  const c = correlationMatrix(inputs, 126)!;
  const n = 4;
  for (let i = 0; i < n; i++) {
    assert.equal(c.matrix[i * n + i], 1);
    for (let j = 0; j < n; j++) {
      assert.equal(c.matrix[i * n + j], c.matrix[j * n + i]);
      assert.ok(Math.abs(c.matrix[i * n + j]) <= 1);
    }
  }
  assert.ok(c.pc1Share > 0 && c.pc1Share <= 1);
  assert.ok(c.clusters.length >= 1);
});

test("相関行列: 3 銘柄未満では作らない", () => {
  assert.equal(correlationMatrix([{ symbol: "A", label: "A", bars: bars(walk(100)) }], 60), null);
});

/* ---------------- ローテーション ---------------- */

test("ローテーション: ベンチマークを上回り続ける銘柄は先行/改善象限に入る", () => {
  // 完全に滑らかな指数関数だと相対力の分散がゼロになり Z が取れないので、
  // ノイズ入りの系列にドリフトを乗せて現実的な形にする
  const drift = (seed: number, rate: number) =>
    bars(walk(400, seed, 100, 0.008).map((v, i) => v * (1 + rate) ** i));
  const bench = drift(101, 0.0005);
  const strong = drift(202, 0.003);
  const p = rotationPoint(inst("STRONG"), strong, bench)!;
  assert.ok(p, "座標が計算できない");
  assert.ok(["leading", "improving", "weakening"].includes(p.quadrant));
  // 相対力が右肩上がりなので RS-Ratio は 100 超
  assert.ok(p.rsRatio > 100, `RS-Ratio=${p.rsRatio}`);
  // 軌跡が付く
  assert.ok(p.trail.length >= 2);
});

test("ローテーション: 履歴が足りなければ null を返す (無理に描かない)", () => {
  assert.equal(rotationPoint(inst("SHORT"), bars(walk(60, 1)), bars(walk(60, 2))), null);
});

test("ローテーション: シクリカル vs ディフェンシブのスプレッド", () => {
  const s = cyclicalDefensiveSpread([
    { rsRatio: 110, cyclicality: "cyclical" },
    { rsRatio: 106, cyclicality: "cyclical" },
    { rsRatio: 94, cyclicality: "defensive" },
    { rsRatio: 90, cyclicality: "defensive" },
    { rsRatio: 100, cyclicality: undefined },
  ])!;
  assert.ok(Math.abs(s - 16) < 1e-9);
});

test("ローテーション: レンジ相場では RS-Ratio が 100 近傍に収まる", () => {
  const bench = bars(trending(400, 100, 0.001));
  const same = bars(sine(400, 60, 0.02).map((v, i) => v * (1.001 ** i)));
  const p = rotationPoint(inst("RANGE"), same, bench);
  if (p) assert.ok(Math.abs(p.rsRatio - 100) < 40, `RS-Ratio が外れすぎ: ${p.rsRatio}`);
});
