import test from "node:test";
import assert from "node:assert/strict";

import {
  OUTLOOK_HORIZON,
  buildOutlook,
  meanReversionTilt,
  regimeTilt,
  regionStrength,
} from "../src/analytics/outlook.ts";
import { buildSectorAggregates } from "../src/analytics/aggregate.ts";
import { computeBreadth } from "../src/analytics/breadth.ts";
import { computeRegime } from "../src/analytics/regime.ts";
import { rotationPoint } from "../src/analytics/rotation.ts";
import { analyzeInstrument, applyCrossSection } from "../src/pipeline.ts";
import { REGION_META } from "../src/config/sectors.ts";
import { UNIVERSE } from "../src/config/universe.ts";
import type {
  InstrumentRecord,
  Regime,
  RotationPoint,
  Series,
} from "../src/types.ts";
import { bars, rng } from "./helpers.ts";

/*
 * セクター見通しは、このダッシュボードで唯一「これから」を語る出力である。
 * 順位の中身が間違っていても画面は普通に出てしまうので、
 *   ・合成の算術 (寄与の合計 = 合成Z)
 *   ・強い入力が上に来るという単調性
 *   ・欠損がスコアを詰め上げないこと
 *   ・保存サイズが Durable Object の 1 値上限を超えないこと
 * を機械的に押さえておく。
 */

/* ------------------------------------------------------------------ */
/* 合成データでユニバース全体を作る                                     */
/* ------------------------------------------------------------------ */

/** シンボルごとに決まったドリフトの終値列を作る (シード固定) */
function closes(n: number, seed: number, drift: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    out.push(c);
    c *= 1 + drift + (r() - 0.5) * 0.02;
  }
  return out;
}

interface World {
  records: Record<string, InstrumentRecord>;
  series: Record<string, Series>;
  rotation: RotationPoint[];
  regime: Regime | null;
}

/**
 * ドリフトの決め方を差し替えられるようにしてある。
 * 「特定のセクターだけ強い世界」を作って順位を検証するため。
 */
function buildWorld(driftOf: (symbol: string, i: number) => number): World {
  const series: Record<string, Series> = {};
  UNIVERSE.forEach((inst, i) => {
    series[inst.symbol] = {
      symbol: inst.symbol,
      name: inst.name,
      currency: inst.currency,
      bars: bars(closes(400, i + 11, driftOf(inst.symbol, i))),
      source: "yahoo",
      fetchedAt: "2026-08-05T00:00:00.000Z",
    };
  });

  const records: Record<string, InstrumentRecord> = {};
  for (const inst of UNIVERSE) {
    const bench = series[REGION_META[inst.region].benchmark] ?? series["^GSPC"] ?? null;
    records[inst.symbol] = analyzeInstrument(inst, series[inst.symbol], bench);
  }
  applyCrossSection(records, undefined);

  const rotation: RotationPoint[] = [];
  for (const inst of UNIVERSE) {
    if (inst.role !== "sector-proxy") continue;
    const bench = series[REGION_META[inst.region].benchmark];
    if (!bench || bench.symbol === inst.symbol) continue;
    const p = rotationPoint(inst, series[inst.symbol].bars, bench.bars);
    if (p) rotation.push(p);
  }

  const regime = computeRegime(records, computeBreadth("グローバル", Object.values(records)));
  return { records, series, rotation, regime };
}

function boardFrom(world: World) {
  const sectors = buildSectorAggregates(world.records);
  return buildOutlook({
    sectors,
    records: world.records,
    rotation: world.rotation,
    regime: world.regime,
    news: [],
  });
}

/** セクターごとに違うが決定論的なドリフト */
const baseWorld = buildWorld((_s, i) => (((i * 37) % 13) / 13) * 0.0016 - 0.0006);
const baseBoard = boardFrom(baseWorld);

/* ------------------------------------------------------------------ */
/* 構造の不変条件                                                      */
/* ------------------------------------------------------------------ */

test("見通し: 板が生成され、上位・下位ともに 5 件まで出る", () => {
  assert.ok(baseBoard, "板が null になっている");
  assert.equal(baseBoard!.horizon, OUTLOOK_HORIZON);
  assert.ok(baseBoard!.bullish.length > 0 && baseBoard!.bullish.length <= 5);
  assert.ok(baseBoard!.bearish.length > 0 && baseBoard!.bearish.length <= 5);
});

test("見通し: 順位は 1..N で重複も欠番も無い", () => {
  const ranks = baseBoard!.all.map((r) => r.rank).sort((a, b) => a - b);
  assert.deepEqual(
    ranks,
    Array.from({ length: baseBoard!.all.length }, (_, i) => i + 1)
  );
});

test("見通し: 順位は合成Zの降順と一致する", () => {
  const sorted = [...baseBoard!.all].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i - 1].z >= sorted[i].z,
      `順位 ${sorted[i - 1].rank} (z=${sorted[i - 1].z}) が ${sorted[i].rank} (z=${sorted[i].z}) より弱い`
    );
  }
});

test("見通し: score は [0,100] で、合成Zと単調に対応する", () => {
  for (const r of baseBoard!.all) {
    assert.ok(r.score >= 0 && r.score <= 100, `score=${r.score} が範囲外`);
    assert.ok(Number.isFinite(r.z));
    // 0 が「中立」ではなく 50 が中立。符号とスコアの向きが食い違うと読み手が誤解する
    if (r.z > 0) assert.ok(r.score > 50, `z=${r.z} なのに score=${r.score}`);
    if (r.z < 0) assert.ok(r.score < 50, `z=${r.z} なのに score=${r.score}`);
  }
});

test("見通し: direction は合成Zの閾値 ±0.25 と整合する", () => {
  for (const r of baseBoard!.all) {
    const expected = r.z >= 0.25 ? "up" : r.z <= -0.25 ? "down" : "neutral";
    assert.equal(r.direction, expected, `z=${r.z} に対する direction が不整合`);
  }
});

test("見通し: 上位は上向き、下位は下向きのシグナルだけを載せる", () => {
  for (const r of baseBoard!.bullish) assert.ok(r.z > 0, `${r.nameJa} が上位に混ざっている`);
  for (const r of baseBoard!.bearish) assert.ok(r.z < 0, `${r.nameJa} が下位に混ざっている`);
  // 下位は「最も弱いものが先頭」でなければ読み手が逆に取る
  for (let i = 1; i < baseBoard!.bearish.length; i++) {
    assert.ok(baseBoard!.bearish[i - 1].z <= baseBoard!.bearish[i].z);
  }
});

test("見通し: 推薦に載るのは材料充足 45% 以上のセルだけ", () => {
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    assert.ok(r.coverage >= 0.45, `${r.nameJa} の充足率 ${r.coverage} が低すぎる`);
  }
});

/* ------------------------------------------------------------------ */
/* 合成の算術                                                          */
/* ------------------------------------------------------------------ */

test("見通し: 柱の寄与の合計が合成Zに一致する", () => {
  // ここがずれると「内訳を見せているのに合計が合わない」状態になり、
  // 開示している意味が無くなる。
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    const sum = r.pillars.reduce((a, p) => a + p.contribution, 0);
    assert.ok(
      Math.abs(sum - r.z) < 0.02,
      `${r.nameJa}: 寄与合計 ${sum.toFixed(3)} と合成Z ${r.z} が一致しない`
    );
  }
});

test("見通し: 評価できなかった柱は寄与 0 で、スコアを押し上げない", () => {
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    for (const p of r.pillars) {
      if (p.z === null) {
        assert.equal(p.contribution, 0, `${r.nameJa}/${p.label}: 欠損なのに寄与が付いている`);
        assert.ok(p.reading.length > 0, "欠損の柱にも理由が要る");
      }
    }
  }
});

test("見通し: 材料充足は「評価できた柱のウェイト比率」と一致する", () => {
  const totalWeight = baseBoard!.bullish[0].pillars.reduce((a, p) => a + p.weight, 0);
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    const used = r.pillars.filter((p) => p.z !== null).reduce((a, p) => a + p.weight, 0);
    assert.ok(Math.abs(used / totalWeight - r.coverage) < 0.01, `${r.nameJa} の充足率が不整合`);
  }
});

test("見通し: 確信度・一致率は [0,100] / [0,1] に収まる", () => {
  for (const r of baseBoard!.all) {
    assert.ok(r.conviction >= 0 && r.conviction <= 100, `conviction=${r.conviction}`);
    assert.ok(r.agreement >= 0 && r.agreement <= 1, `agreement=${r.agreement}`);
    assert.ok(r.coverage > 0 && r.coverage <= 1, `coverage=${r.coverage}`);
  }
});

test("見通し: 柱の全一致より、柱が割れているほうが確信度が低い", () => {
  // 同じスコアでも「材料が割れている」ことが読み手に伝わらないと、
  // 順位だけが独り歩きする。
  const pairs = baseBoard!.all.filter((r) => Math.abs(r.z) > 0.3);
  const high = pairs.filter((r) => r.agreement >= 0.85);
  const low = pairs.filter((r) => r.agreement <= 0.6);
  if (high.length > 0 && low.length > 0) {
    const mh = high.reduce((a, r) => a + r.conviction, 0) / high.length;
    const ml = low.reduce((a, r) => a + r.conviction, 0) / low.length;
    assert.ok(mh > ml, `一致率が高い群の確信度 ${mh} が低い群 ${ml} を上回っていない`);
  }
});

/* ------------------------------------------------------------------ */
/* 単調性                                                              */
/* ------------------------------------------------------------------ */

test("見通し: 価格を明確に強くしたセクターは順位が上がる", () => {
  // 米国エネルギー (XLE) だけを強いドリフトにした世界を作り、
  // 元の世界より順位が上がることを確認する。
  const target = "XLE";
  const strong = buildWorld((sym, i) =>
    sym === target ? 0.0025 : (((i * 37) % 13) / 13) * 0.0016 - 0.0006
  );
  const board = boardFrom(strong);
  assert.ok(board);

  const before = baseBoard!.all.find((r) => r.proxySymbol === target);
  const after = board!.all.find((r) => r.proxySymbol === target);
  assert.ok(before && after, "対象セクターが板に出ていない");
  assert.ok(
    after!.rank < before!.rank,
    `強くしたのに順位が上がっていない (${before!.rank} → ${after!.rank})`
  );
  assert.ok(after!.z > before!.z, "強くしたのに合成Zが上がっていない");
});

/* ------------------------------------------------------------------ */
/* 文章化                                                              */
/* ------------------------------------------------------------------ */

test("見通し: 推薦には必ず論拠と否定条件が付く", () => {
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    assert.ok(r.thesis.length > 10, `${r.nameJa} の論拠が空`);
    // 「上がると思う」と書いたなら、何が起きたら外れかを必ず先に書く
    assert.ok(r.invalidation.length > 10, `${r.nameJa} の否定条件が空`);
    assert.ok(r.invalidation.includes("無効"), `${r.nameJa} の否定条件が条件になっていない`);
    assert.ok(r.horizon === OUTLOOK_HORIZON);
  }
});

test("見通し: 想定変動幅は正の値か null (方向を持たない)", () => {
  for (const r of [...baseBoard!.bullish, ...baseBoard!.bearish]) {
    if (r.expectedMove1m !== null) {
      assert.ok(r.expectedMove1m > 0, `想定変動 ${r.expectedMove1m} が負`);
      assert.ok(r.expectedMove1m < 1, `想定変動 ${r.expectedMove1m} が非現実的`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 保存サイズ                                                          */
/* ------------------------------------------------------------------ */

test("見通し: JSON が Durable Object の 1 値上限 (128 KiB) に収まる", () => {
  // 全セルに柱の内訳を持たせると軽く超える。上位・下位だけ内訳を持ち、
  // 一覧は軽量行にしてある — その設計が守られているかの番人。
  const size = new TextEncoder().encode(JSON.stringify(baseBoard)).length;
  assert.ok(size < 128 * 1024, `見通しの JSON が ${size} バイトで上限を超える`);
});

test("見通し: 一覧行には柱の内訳を持たせない (サイズ設計の担保)", () => {
  for (const r of baseBoard!.all) {
    assert.equal((r as unknown as { pillars?: unknown }).pillars, undefined);
    assert.ok(typeof r.score === "number");
  }
});

/* ------------------------------------------------------------------ */
/* セル数が足りないとき                                                */
/* ------------------------------------------------------------------ */

test("見通し: 比較できるセルが 4 未満なら板を作らない", () => {
  const sectors = buildSectorAggregates(baseWorld.records).slice(0, 3);
  const board = buildOutlook({
    sectors,
    records: baseWorld.records,
    rotation: baseWorld.rotation,
    regime: baseWorld.regime,
    news: [],
  });
  assert.equal(board, null, "比較対象が無いのに順位を出している");
});

test("見通し: 市場全体・マクロのセルはランキングに載せない", () => {
  for (const r of baseBoard!.all) {
    assert.ok(r.sector !== "broad" && r.sector !== "macro", `${r.sector} が混ざっている`);
  }
});

/* ------------------------------------------------------------------ */
/* レジーム整合                                                        */
/* ------------------------------------------------------------------ */

const regimeOf = (over: Partial<Regime>): Regime => ({
  asOf: "2026-08-05T00:00:00.000Z",
  trend: "range",
  trendConfidence: 0.5,
  volatility: "normal",
  riskAppetite: "neutral",
  evidence: [],
  playbook: [],
  ...over,
});

test("レジーム整合: リスクオンではシクリカルが加点、ディフェンシブが減点", () => {
  const r = regimeOf({ riskAppetite: "risk-on" });
  assert.ok(regimeTilt({ regime: r, cyclicality: "cyclical" }).z! > 0);
  assert.ok(regimeTilt({ regime: r, cyclicality: "defensive" }).z! < 0);
});

test("レジーム整合: リスクオフでは符号が反転する", () => {
  const on = regimeOf({ riskAppetite: "risk-on" });
  const off = regimeOf({ riskAppetite: "risk-off" });
  const a = regimeTilt({ regime: on, cyclicality: "cyclical" }).z!;
  const b = regimeTilt({ regime: off, cyclicality: "cyclical" }).z!;
  assert.equal(Math.sign(a), -Math.sign(b));
});

test("レジーム整合: 3軸が食い違う地形では傾きが打ち消し合う", () => {
  // 上昇基調だがボラはストレス、という地形。片方だけ見て断定しないこと。
  const mixed = regimeOf({
    trend: "bull",
    trendConfidence: 1,
    volatility: "stress",
    riskAppetite: "neutral",
  });
  const z = regimeTilt({ regime: mixed, cyclicality: "cyclical" }).z!;
  assert.ok(Math.abs(z) < 0.3, `打ち消し合っていない (z=${z})`);
});

test("レジーム整合: 中間セクターは 0、レジーム未判定なら null", () => {
  assert.equal(regimeTilt({ regime: regimeOf({}), cyclicality: "neutral" }).z, 0);
  assert.equal(regimeTilt({ regime: null, cyclicality: "cyclical" }).z, null);
});

test("レジーム整合: 傾きは ±1.5 で飽和する", () => {
  const extreme = regimeOf({
    trend: "bull",
    trendConfidence: 1,
    volatility: "low",
    riskAppetite: "risk-on",
  });
  const z = regimeTilt({ regime: extreme, cyclicality: "cyclical" }).z!;
  assert.ok(z <= 1.5 && z > 0);
});

/* ------------------------------------------------------------------ */
/* 平均回帰                                                            */
/* ------------------------------------------------------------------ */

test("平均回帰: 通常域では 0 を返し、モメンタムの柱を邪魔しない", () => {
  assert.equal(meanReversionTilt({ rsi: 55, deviation200: 0.04 }).z, 0);
  assert.equal(meanReversionTilt({ rsi: 45, deviation200: -0.1 }).z, 0);
});

test("平均回帰: 買われ過ぎは減点、売られ過ぎは加点", () => {
  assert.ok(meanReversionTilt({ rsi: 82, deviation200: 0.3 }).z! < 0);
  assert.ok(meanReversionTilt({ rsi: 22, deviation200: -0.3 }).z! > 0);
});

test("平均回帰: 極端な入力でも ±1.5 を超えない", () => {
  assert.ok(meanReversionTilt({ rsi: 100, deviation200: 5 }).z! >= -1.5);
  assert.ok(meanReversionTilt({ rsi: 0, deviation200: -0.9 }).z! <= 1.5);
});

test("平均回帰: 指標がまったく無ければ null (0 で埋めない)", () => {
  assert.equal(meanReversionTilt({ rsi: null, deviation200: null }).z, null);
  // 片方だけでも評価はできる
  assert.notEqual(meanReversionTilt({ rsi: 85, deviation200: null }).z, null);
});

/* ------------------------------------------------------------------ */
/* 地域の強弱                                                          */
/* ------------------------------------------------------------------ */

test("地域の強弱: 3 地域未満なら null (地域間の相対を名乗らない)", () => {
  const z = regionStrength(baseWorld.records, ["US", "JP"]);
  assert.equal(z.get("US"), null);
  assert.equal(z.get("JP"), null);
});

test("地域の強弱: 3 地域以上なら Z が付き、平均はほぼ 0", () => {
  const regions = ["US", "JP", "EU", "UK"] as const;
  const z = regionStrength(baseWorld.records, [...regions]);
  const vals = regions.map((r) => z.get(r)).filter((x): x is number => typeof x === "number");
  assert.ok(vals.length >= 3, "地域の Z が付いていない");
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  assert.ok(Math.abs(m) < 0.5, `Z の平均が 0 から離れすぎ (${m})`);
});
