import test from "node:test";
import assert from "node:assert/strict";
import { PLAYBOOKS, generateIdeas } from "../src/analytics/ideas.ts";
import { computeRelated } from "../src/analytics/related.ts";
import type { RelatedInput } from "../src/analytics/related.ts";
import { GLOSSARY } from "../src/config/glossary.ts";
import { THEMES, themeNeighbors, themesFor } from "../src/config/themes.ts";
import { UNIVERSE } from "../src/config/universe.ts";
import { analyzeInstrument, applyCrossSection } from "../src/pipeline.ts";
import type {
  Fundamentals,
  Instrument,
  InstrumentRecord,
  Regime,
  Series,
} from "../src/types.ts";
import { bars, trending, walk } from "./helpers.ts";

/* ------------------------------------------------------------------ */
/* テスト用のレコード生成                                              */
/* ------------------------------------------------------------------ */

const instrument = (symbol: string, over: Partial<Instrument> = {}): Instrument => ({
  symbol, name: symbol, nameJa: symbol, region: "US", sector: "tech",
  assetClass: "equity", role: "constituent", currency: "USD", ...over,
});

const series = (symbol: string, closes: number[]): Series => ({
  symbol, name: symbol, currency: "USD", bars: bars(closes), source: "yahoo",
  fetchedAt: "2026-08-07T00:00:00.000Z",
});

function fundamentals(symbol: string, over: Partial<Fundamentals> = {}): Fundamentals {
  return {
    symbol, asOf: "2026-08-07T00:00:00.000Z", source: "test", currency: "USD",
    marketCap: 1e11, enterpriseValue: 1.1e11, sharesOutstanding: 1e9, floatShares: 9e8,
    trailingPE: 20, forwardPE: 18, pegRatio: 1.4, priceToBook: 4, priceToSales: 5,
    evToEbitda: 14, evToSales: 5.2, evToFcf: 22, earningsYield: 0.05, fcfYield: 0.045,
    dividendYield: 0.015, payoutRatio: 0.3, buybackYield: null,
    returnOnEquity: 0.22, returnOnAssets: 0.11, returnOnInvestedCapital: 0.15,
    grossMargin: 0.5, operatingMargin: 0.25, profitMargin: 0.18, ebitdaMargin: 0.3,
    debtToEquity: 55, netDebtToEbitda: 1.1, currentRatio: 1.6, quickRatio: 1.2,
    interestCoverage: 15, totalCash: 2e10, totalDebt: 2.5e10,
    revenueGrowth: 0.13, earningsGrowth: 0.16, earningsQuarterlyGrowth: 0.12, revenue3yCagr: 0.12,
    beta: 1.05, shortPercentOfFloat: 0.02, heldPercentInstitutions: 0.72, heldPercentInsiders: 0.03,
    trailingEps: 6, forwardEps: 7, bookValuePerShare: 30, revenuePerShare: 24,
    revenueValue: 2.4e10, ebitdaValue: 7e9, ebitValue: 6e9, freeCashflowValue: 5e9,
    operatingCashflowValue: 6.5e9, totalEquityValue: 3e10, interestExpenseValue: 4e8,
    fieldSources: { trailingPE: "test" },
    ...over,
  };
}

/** 強い上昇 / 割安 / ディフェンシブ / レンジ の 4 タイプを含む母集団を作る */
function buildRecords(): Record<string, InstrumentRecord> {
  const out: Record<string, InstrumentRecord> = {};
  const bench = series("^GSPC", trending(320, 100, 0.0015));

  const add = (
    sym: string,
    closes: number[],
    inst: Partial<Instrument>,
    fu: Partial<Fundamentals>
  ) => {
    const rec = analyzeInstrument(instrument(sym, inst), series(sym, closes), bench);
    rec.fundamentals = fundamentals(sym, fu);
    out[sym] = rec;
  };

  // 強い上昇 + 高ROE (クオリティ×モメンタム / ブレイクアウト向き)
  for (let i = 0; i < 4; i++) {
    add(`MOM${i}`, trending(320, 100, 0.0035 - i * 0.0002), { sector: "tech" }, {
      returnOnEquity: 0.32 - i * 0.02, operatingMargin: 0.3, forwardPE: 26 + i,
      priceToBook: 8, dividendYield: 0.004, payoutRatio: 0.12,
    });
  }
  // 割安 + 黒字 + 横ばい〜やや上 (バリュー向き)
  for (let i = 0; i < 4; i++) {
    add(`VAL${i}`, trending(320, 100, 0.0004 + i * 0.0001), { sector: "banks" }, {
      forwardPE: 8 + i, trailingPE: 9 + i, priceToBook: 0.8 + i * 0.05,
      returnOnEquity: 0.11, operatingMargin: 0.28, fcfYield: 0.08,
      dividendYield: 0.038, payoutRatio: 0.42, debtToEquity: 90,
    });
  }
  // 低ボラ・ディフェンシブ
  for (let i = 0; i < 4; i++) {
    add(`DEF${i}`, walk(320, 40 + i, 100, 0.004), { sector: "staples" }, {
      returnOnEquity: 0.24, operatingMargin: 0.2, forwardPE: 20,
      dividendYield: 0.031 + i * 0.002, payoutRatio: 0.55, debtToEquity: 70,
      priceToBook: 5,
    });
  }
  // 下降 (どの戦術にも乗らないはずの銘柄)
  for (let i = 0; i < 3; i++) {
    add(`DWN${i}`, trending(320, 300, -0.0035), { sector: "energy" }, {
      returnOnEquity: 0.03, operatingMargin: -0.05, forwardPE: 40, priceToBook: 3,
      dividendYield: 0.001, payoutRatio: 0.9,
    });
  }

  out["^GSPC"] = analyzeInstrument(
    instrument("^GSPC", { role: "benchmark", assetClass: "index", sector: "broad" }),
    bench,
    null
  );

  applyCrossSection(out, undefined);
  return out;
}

const regime = (over: Partial<Regime> = {}): Regime => ({
  asOf: "2026-08-07T00:00:00.000Z",
  trend: "bull", trendConfidence: 0.8, volatility: "normal", riskAppetite: "risk-on",
  evidence: [], playbook: [], ...over,
});

/* ------------------------------------------------------------------ */
/* テーマ定義                                                          */
/* ------------------------------------------------------------------ */

test("テーマの銘柄はすべてユニバースに存在する", () => {
  const known = new Set(UNIVERSE.map((i) => i.symbol));
  for (const t of THEMES) {
    for (const c of t.chain) {
      assert.ok(c.symbols.length > 0, `${t.id}/${c.stage} が空`);
      for (const s of c.symbols) {
        assert.ok(known.has(s), `${t.id}/${c.stage}: ${s} がユニバースに無い`);
      }
    }
  }
});

test("テーマは波及の順序と、崩れる条件を必ず持つ", () => {
  for (const t of THEMES) {
    assert.ok(t.chain.length >= 2, `${t.id}: 波及の段が 1 つしかない`);
    assert.ok(t.breaks.length > 15, `${t.id}: breaks が薄い`);
    assert.ok(t.plain.length > 30, `${t.id}: 初心者向け説明が薄い`);
    assert.ok(t.driver.length > 5, `${t.id}: driver が未記入`);
  }
});

test("themeNeighbors は自分を除き、他の段を役割つきで返す", () => {
  const n = themeNeighbors("NVDA");
  assert.ok(n.length > 0, "NVDA がどのテーマにも属していない");
  const ai = n.find((x) => x.theme.id === "ai-datacenter")!;
  assert.ok(ai, "AIデータセンターに属していない");
  assert.ok(!ai.sameStage.includes("NVDA"), "自分自身が同じ段に含まれている");
  assert.ok(ai.otherStages.every((s) => s.role.length > 0), "役割の記述がない段がある");
  assert.equal(themesFor("存在しない銘柄").length, 0);
});

/* ------------------------------------------------------------------ */
/* 用語解説                                                            */
/* ------------------------------------------------------------------ */

test("用語解説は全項目に「意味・高い・低い・落とし穴」が揃っている", () => {
  const keys = Object.keys(GLOSSARY);
  assert.ok(keys.length >= 30, `用語が少なすぎる: ${keys.length}`);
  for (const k of keys) {
    const g = GLOSSARY[k];
    assert.ok(g.term.length > 0, `${k}: term`);
    assert.ok(g.short.length > 3, `${k}: short`);
    assert.ok(g.plain.length > 20, `${k}: plain が薄い`);
    assert.ok(g.high.length > 5, `${k}: high`);
    assert.ok(g.low.length > 5, `${k}: low`);
    // 落とし穴が書かれていない用語は、指標の意味だけ教えて誤用を招く
    assert.ok(g.trap.length > 20, `${k}: trap (落とし穴) が薄い`);
  }
});

test("用語解説の相互参照 (see) は実在するキーを指す", () => {
  for (const [k, g] of Object.entries(GLOSSARY)) {
    for (const ref of g.see ?? []) {
      assert.ok(GLOSSARY[ref], `${k}.see が未収録の用語 ${ref} を参照している`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* アイデア生成                                                        */
/* ------------------------------------------------------------------ */

test("レジームによって有効な戦術が切り替わる", () => {
  const recs = buildRecords();

  const bull = generateIdeas(recs, regime({ trend: "bull", riskAppetite: "risk-on" }));
  const bullIds = bull.activePlaybooks.map((p) => p.id);
  assert.ok(bullIds.includes("momentum-quality"), "上昇基調で順張りが有効化されない");
  assert.ok(!bullIds.includes("defensive-rotation"), "上昇基調でディフェンシブが有効化されている");

  const bear = generateIdeas(recs, regime({ trend: "bear", riskAppetite: "risk-off", volatility: "stress" }));
  const bearIds = bear.activePlaybooks.map((p) => p.id);
  assert.ok(bearIds.includes("defensive-rotation"), "下降基調でディフェンシブが有効化されない");
  assert.ok(!bearIds.includes("momentum-quality"), "下降基調で順張りが有効化されている");
  assert.ok(!bearIds.includes("breakout"), "下降基調でブレイクアウトが有効化されている");

  const range = generateIdeas(recs, regime({ trend: "range" }));
  assert.ok(range.activePlaybooks.map((p) => p.id).includes("mean-reversion"),
    "レンジで逆張りが有効化されない");
});

test("レジームが取れていなければ戦術を 1 つも有効化しない", () => {
  const book = generateIdeas(buildRecords(), null);
  assert.equal(book.activePlaybooks.length, 0);
  assert.equal(book.ideas.length, 0);
  assert.equal(book.regime, null);
});

test("全アイデアが根拠3本以上・反証2本以上を伴う", () => {
  const book = generateIdeas(buildRecords(), regime());
  assert.ok(book.ideas.length > 0, "候補が 1 件も出ない");
  for (const i of book.ideas) {
    assert.ok(i.thesis.length >= 3, `${i.id}: 根拠が ${i.thesis.length} 本しかない`);
    assert.ok(i.risks.length >= 2, `${i.id}: 反証が ${i.risks.length} 本しかない`);
    // 根拠には必ず実数が入る (数字の無い根拠は占いと区別が付かない)
    const withNumbers = i.thesis.filter((t) => /\d/.test(t)).length;
    assert.ok(
      withNumbers >= i.thesis.length - 1,
      `${i.id}: 数値を伴わない根拠が多い (${i.thesis.length - withNumbers}本)`
    );
    assert.ok(i.plain.length > 30, `${i.id}: 初心者向け説明が薄い`);
    assert.ok(i.headline.length > 10, `${i.id}: 要旨が薄い`);
    assert.ok(i.regimeFit.length > 10, `${i.id}: レジーム適合の説明がない`);
    assert.ok([1, 2, 3].includes(i.conviction));
    assert.ok(i.evidence.length >= 3, `${i.id}: 主要数値が少ない`);
  }
});

test("アイデアの evidence が参照する用語キーは実在する", () => {
  // ここが壊れると、UI で用語をタップしても何も出ないという
  // 「静かに壊れる」不具合になる
  const book = generateIdeas(buildRecords(), regime());
  for (const i of book.ideas) {
    for (const e of i.evidence) {
      if (e.glossary) {
        assert.ok(GLOSSARY[e.glossary], `${i.id}: 未収録の用語キー ${e.glossary}`);
      }
    }
  }
});

test("順位は 1 から連番で、確信度の高い順に並ぶ", () => {
  const book = generateIdeas(buildRecords(), regime(), { limit: 10 });
  book.ideas.forEach((i, k) => assert.equal(i.rank, k + 1));
  for (let k = 1; k < book.ideas.length; k++) {
    assert.ok(
      book.ideas[k - 1].conviction >= book.ideas[k].conviction,
      "確信度の順に並んでいない"
    );
  }
});

test("下降・赤字の銘柄は上昇局面のアイデアに現れない", () => {
  const book = generateIdeas(buildRecords(), regime({ trend: "bull", riskAppetite: "risk-on" }));
  const syms = book.ideas.map((i) => i.symbol);
  for (const s of syms) {
    assert.ok(!s.startsWith("DWN"), `下降・営業赤字の ${s} が候補に入っている`);
  }
});

test("母集団と免責が必ず添えられる", () => {
  const book = generateIdeas(buildRecords(), regime());
  assert.match(book.universeNote, /銘柄の中から選/);
  assert.match(book.disclaimer, /投資助言ではありません/);
});

test("戦術の定義はすべて初心者向け説明を持つ", () => {
  for (const pb of PLAYBOOKS) {
    assert.ok(pb.plain.length > 40, `${pb.id}: 初心者向け説明が薄い`);
    assert.ok(pb.nameJa.length > 0);
  }
});

test("地域で絞り込める", () => {
  const recs = buildRecords();
  recs.MOM0.instrument = { ...recs.MOM0.instrument, region: "JP" };
  const book = generateIdeas(recs, regime(), { regions: ["JP"] });
  for (const i of book.ideas) assert.equal(i.region, "JP");
});

/* ------------------------------------------------------------------ */
/* 関連銘柄                                                            */
/* ------------------------------------------------------------------ */

function relatedPool(recs: Record<string, InstrumentRecord>, closes: Record<string, number[]>): RelatedInput[] {
  return Object.entries(recs)
    .filter(([s]) => closes[s])
    .map(([s, record]) => ({ symbol: s, record, bars: bars(closes[s]) }));
}

test("関連銘柄: 連動と分散を相関で正しく仕分ける", () => {
  const base = walk(320, 11, 100, 0.012);
  const closes: Record<string, number[]> = {
    TGT: base,
    // ほぼ同じ動き → 連動
    SAME: base.map((c, i) => c * (1 + Math.sin(i / 50) * 0.002)),
    // 無関係な動き → 分散
    INDEP: walk(320, 99, 100, 0.012),
    OTHER: walk(320, 77, 100, 0.012),
  };
  const recs: Record<string, InstrumentRecord> = {};
  for (const s of Object.keys(closes)) {
    recs[s] = analyzeInstrument(instrument(s), series(s, closes[s]), null);
    recs[s].fundamentals = fundamentals(s);
  }
  applyCrossSection(recs, undefined);

  const pool = relatedPool(recs, closes);
  const rel = computeRelated(
    { symbol: "TGT", record: recs.TGT, bars: bars(closes.TGT) },
    pool.filter((p) => p.symbol !== "TGT")
  );

  assert.ok(rel.length > 0, "関連が 1 件も出ない");
  for (const r of rel) {
    assert.ok(r.strength >= 0 && r.strength <= 1, `強度が範囲外: ${r.strength}`);
    assert.ok(r.evidence.length > 3, `${r.symbol}: 根拠が空`);
    assert.ok(r.plain.length > 15, `${r.symbol}: 初心者向け説明が薄い`);
    assert.ok(r.kindLabel.length > 0);
    assert.notEqual(r.symbol, "TGT", "自分自身が関連に含まれている");
  }
  const co = rel.filter((r) => r.kind === "co-moving").map((r) => r.symbol);
  assert.ok(co.includes("SAME"), `ほぼ同一の値動きが連動として検出されない (${co.join(",")})`);
});

test("関連銘柄: 種別ごとに件数の上限が守られる", () => {
  const recs = buildRecords();
  const closes: Record<string, number[]> = {};
  for (const s of Object.keys(recs)) closes[s] = trending(320, 100, 0.001);
  const pool = relatedPool(recs, closes);
  const rel = computeRelated(
    { symbol: "MOM0", record: recs.MOM0, bars: bars(closes.MOM0) },
    pool.filter((p) => p.symbol !== "MOM0"),
    { perKind: 2 }
  );
  const byKind = new Map<string, number>();
  for (const r of rel) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  for (const [kind, n] of byKind) assert.ok(n <= 2, `${kind} が ${n} 件 (上限 2)`);
});

test("関連銘柄: 比較対象が少なすぎても落ちない", () => {
  const recs = buildRecords();
  const closes = { MOM0: trending(320, 100, 0.002) };
  const rel = computeRelated(
    { symbol: "MOM0", record: recs.MOM0, bars: bars(closes.MOM0) },
    []
  );
  assert.deepEqual(rel, []);
});
