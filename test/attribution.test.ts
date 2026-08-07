import test from "node:test";
import assert from "node:assert/strict";
import { approxPValue, invert, isSignificant, ols } from "../src/analytics/regression.ts";
import { attributeGroup, attributeInstrument } from "../src/analytics/attribution.ts";
import { parseFrenchCsv, frenchDateToDayKey } from "../src/datasources/kenfrench.ts";
import type { FactorDay } from "../src/datasources/kenfrench.ts";
import type { Bar } from "../src/types.ts";
import { rng } from "./helpers.ts";

/* ------------------------------------------------------------------ */
/* 行列・回帰                                                          */
/* ------------------------------------------------------------------ */

test("逆行列: 既知の行列で検証し、特異行列では null を返す", () => {
  const a = [
    [4, 7],
    [2, 6],
  ];
  const inv = invert(a)!;
  // [[0.6,-0.7],[-0.2,0.4]]
  assert.ok(Math.abs(inv[0][0] - 0.6) < 1e-12);
  assert.ok(Math.abs(inv[0][1] + 0.7) < 1e-12);
  assert.ok(Math.abs(inv[1][0] + 0.2) < 1e-12);
  assert.ok(Math.abs(inv[1][1] - 0.4) < 1e-12);

  // 2行目が1行目の定数倍 = 特異。ここで適当な値を返すと
  // 意味のない係数に t 値が付いてしまう
  assert.equal(invert([[1, 2], [2, 4]]), null);
});

test("OLS: ノイズ無しの既知の関係を厳密に復元する", () => {
  // y = 3 + 2·x1 - 1.5·x2
  const X: number[][] = [];
  const y: number[] = [];
  const r = rng(42);
  for (let i = 0; i < 120; i++) {
    const x1 = r() * 10;
    const x2 = r() * 5;
    X.push([x1, x2]);
    y.push(3 + 2 * x1 - 1.5 * x2);
  }
  const res = ols(X, y)!;
  assert.ok(res, "回帰が解けない");
  assert.ok(Math.abs(res.intercept - 3) < 1e-9, `切片 ${res.intercept}`);
  assert.ok(Math.abs(res.coefficients[0] - 2) < 1e-9, `β1 ${res.coefficients[0]}`);
  assert.ok(Math.abs(res.coefficients[1] + 1.5) < 1e-9, `β2 ${res.coefficients[1]}`);
  assert.ok(res.rSquared > 0.9999);
});

test("OLS: ノイズ入りでも係数を近似し、無関係な変数は有意にならない", () => {
  const r = rng(7);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 500; i++) {
    const x1 = r() * 4 - 2;
    const noise = (r() - 0.5) * 0.4;
    const irrelevant = r() * 4 - 2; // y に一切寄与しない
    X.push([x1, irrelevant]);
    y.push(1.2 * x1 + noise);
  }
  const res = ols(X, y)!;
  assert.ok(Math.abs(res.coefficients[0] - 1.2) < 0.05, `β1 ${res.coefficients[0]}`);
  assert.ok(isSignificant(res.tStats[0]), "本物の説明変数が有意にならない");
  assert.ok(
    !isSignificant(res.tStats[1]),
    `無関係な変数が有意になっている (t=${res.tStats[1].toFixed(2)})`
  );
});

test("OLS: 観測が説明変数に対して少なすぎるなら解かない", () => {
  // 説明変数 2 本 + 切片 = 3。観測 20 では 1 変数あたり 10 観測に満たない
  const X = Array.from({ length: 20 }, (_, i) => [i, i * i]);
  const y = X.map(([a]) => a * 2);
  assert.equal(ols(X, y), null);
});

test("p 値の近似は t 値の常識的な値と整合する", () => {
  assert.ok(Math.abs(approxPValue(1.96)! - 0.05) < 0.005, `t=1.96 → ${approxPValue(1.96)}`);
  assert.ok(Math.abs(approxPValue(2.58)! - 0.01) < 0.005, `t=2.58 → ${approxPValue(2.58)}`);
  assert.ok(approxPValue(0)! > 0.99);
  assert.ok(approxPValue(5)! < 0.001);
  assert.equal(isSignificant(1.5), false);
  assert.equal(isSignificant(-2.5), true);
  assert.equal(isSignificant(null), false);
});

/* ------------------------------------------------------------------ */
/* Ken French の CSV パース                                            */
/* ------------------------------------------------------------------ */

test("Ken French CSV: 説明文と末尾の別集計を無視して日次行だけ拾う", () => {
  const csv = [
    "This file was created by CMPT_ME_BEVME_OP_INV_RETS_DAILY using the CRSP database.",
    "",
    ",Mkt-RF,SMB,HML,RMW,CMA,RF",
    " 19630701,   -0.67,    0.02,   -0.35,    0.03,    0.13,  0.012",
    " 19630702,    0.79,   -0.28,    0.28,   -0.08,   -0.21,  0.012",
    "",
    "  Annual Factors: January-December",
    "",
    "1964,  16.30,   3.75,  10.34,   1.30,   2.44,  3.54",
  ].join("\n");
  const rows = parseFrenchCsv(csv, 6);
  assert.equal(rows.length, 2, "日次行だけを拾えていない");
  assert.equal(rows[0].d, 19630701);
  // パーセント → 小数への変換
  assert.ok(Math.abs(rows[0].v[0] + 0.0067) < 1e-12, `Mkt-RF ${rows[0].v[0]}`);
  assert.ok(Math.abs(rows[0].v[5] - 0.00012) < 1e-15, `RF ${rows[0].v[5]}`);
  assert.ok(Math.abs(rows[1].v[1] + 0.0028) < 1e-12);
});

test("Ken French CSV: 欠損コード (-99.99) の行は落とす", () => {
  const csv = [
    ",Mom",
    "20260101,   0.56",
    "20260102, -99.99",
    "20260103,  -0.21",
  ].join("\n");
  const rows = parseFrenchCsv(csv, 1);
  assert.equal(rows.length, 2, "欠損コードが混入している");
  assert.deepEqual(rows.map((r) => r.d), [20260101, 20260103]);
});

test("日付キー変換が価格系列の日付と噛み合う", () => {
  const key = frenchDateToDayKey(20260805);
  const ts = Date.UTC(2026, 7, 5) / 1000;
  assert.equal(key, Math.floor(ts / 86400));
});

/* ------------------------------------------------------------------ */
/* ファクター帰属                                                      */
/* ------------------------------------------------------------------ */

/** 決定論的なファクター系列を作る */
function makeFactors(n: number, seed = 3): FactorDay[] {
  const r = rng(seed);
  const out: FactorDay[] = [];
  const start = Date.UTC(2024, 0, 2) / 1000;
  for (let i = 0; i < n; i++) {
    const t = start + i * 86400;
    const dt = new Date(t * 1000);
    const d =
      dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    out.push({
      d,
      mktRf: (r() - 0.5) * 0.02,
      smb: (r() - 0.5) * 0.01,
      hml: (r() - 0.5) * 0.01,
      rmw: (r() - 0.5) * 0.008,
      cma: (r() - 0.5) * 0.008,
      rf: 0.00002,
      mom: (r() - 0.5) * 0.012,
    });
  }
  return out;
}

/** ファクターから決まる価格系列を作る (帰属で復元できるはず) */
function barsFromFactors(
  factors: FactorDay[],
  betas: { mkt: number; smb?: number; hml?: number; mom?: number },
  alphaDaily = 0,
  noise = 0,
  seed = 9
): Bar[] {
  const r = rng(seed);
  const out: Bar[] = [];
  let price = 100;
  for (const f of factors) {
    const ret =
      alphaDaily +
      betas.mkt * f.mktRf +
      (betas.smb ?? 0) * f.smb +
      (betas.hml ?? 0) * f.hml +
      (betas.mom ?? 0) * (f.mom ?? 0) +
      f.rf +
      (noise > 0 ? (r() - 0.5) * noise : 0);
    price *= 1 + ret;
    const t = Math.floor(Date.UTC(
      Math.floor(f.d / 10000),
      Math.floor((f.d % 10000) / 100) - 1,
      f.d % 100
    ) / 1000);
    out.push({ t, o: price, h: price, l: price, c: price, v: 1e6 });
  }
  return out;
}

test("帰属: 既知のβを持つ合成銘柄から、そのβを復元する", () => {
  const factors = makeFactors(300);
  const bars = barsFromFactors(factors, { mkt: 1.3, smb: -0.5, hml: 0.4, mom: 0.2 });
  const a = attributeInstrument(bars, factors, 250)!;
  assert.ok(a, "帰属が計算できない");

  const get = (k: string) => a.loadings.find((l) => l.factor === k)!.beta;
  assert.ok(Math.abs(get("mktRf") - 1.3) < 0.05, `Mkt β ${get("mktRf")}`);
  assert.ok(Math.abs(get("smb") + 0.5) < 0.05, `SMB β ${get("smb")}`);
  assert.ok(Math.abs(get("hml") - 0.4) < 0.05, `HML β ${get("hml")}`);
  assert.ok(Math.abs(get("mom") - 0.2) < 0.05, `Mom β ${get("mom")}`);
  // ファクターだけで作った系列なので当てはまりはほぼ完全
  assert.ok(a.rSquared > 0.95, `R² ${a.rSquared}`);
});

test("帰属: α が無い銘柄は「説明が付く」と判定される", () => {
  const factors = makeFactors(300);
  const bars = barsFromFactors(factors, { mkt: 1.0, smb: 0.2 }, 0, 0.004, 11);
  const a = attributeInstrument(bars, factors, 250)!;
  assert.ok(!a.alphaSignificant, `α が有意になっている (t=${a.alphaT})`);
  assert.match(a.verdict, /既知のファクターで説明が付く/);
});

test("帰属: 本物の α を持つ銘柄では有意な α を検出する", () => {
  const factors = makeFactors(300);
  // 日次 +0.08% の超過リターンを乗せる (年率 ~20%)
  const bars = barsFromFactors(factors, { mkt: 1.0 }, 0.0008, 0.002, 13);
  const a = attributeInstrument(bars, factors, 250)!;
  assert.ok(a.alphaSignificant, `α が検出されない (t=${a.alphaT})`);
  assert.ok(a.alphaAnnual > 0.1, `年率 α が小さい: ${a.alphaAnnual}`);
  assert.match(a.verdict, /説明できない超過リターン/);
});

test("帰属: 観測が足りなければ null (無理に数字を出さない)", () => {
  const factors = makeFactors(300);
  const bars = barsFromFactors(factors, { mkt: 1 }).slice(0, 40);
  assert.equal(attributeInstrument(bars, factors, 250), null);
});

test("帰属: モメンタムが大量に欠けていれば 5 ファクターに落とす", () => {
  const factors = makeFactors(300).map((f, i) => (i % 2 === 0 ? { ...f, mom: null } : f));
  const bars = barsFromFactors(factors, { mkt: 1.1 });
  const a = attributeInstrument(bars, factors, 250)!;
  assert.ok(a, "帰属が計算できない");
  assert.ok(!a.factorsUsed.includes("mom"), "欠損だらけのモメンタムを使っている");
  assert.equal(a.loadings.length, 5);
});

test("群の傾斜: 構成銘柄に共通する傾斜を検出し、成績ではない旨を必ず添える", () => {
  const factors = makeFactors(320);
  // 全員が小型株寄り (SMB に正の傾斜)
  const members = [1, 2, 3, 4, 5].map((k) => ({
    symbol: `S${k}`,
    bars: barsFromFactors(factors, { mkt: 1.0, smb: 0.8 }, 0, 0.003, 20 + k),
  }));
  const tilt = attributeGroup(members, factors, "テスト群", 250)!;
  assert.ok(tilt, "傾斜が計算できない");
  assert.equal(tilt.memberCount, 5);

  const smb = tilt.loadings.find((l) => l.factor === "smb")!;
  assert.ok(Math.abs(smb.beta - 0.8) < 0.15, `SMB β ${smb.beta}`);
  assert.ok(smb.significant, "共通の傾斜が有意にならない");
  assert.match(tilt.dominantTilt, /規模/);

  // 成績と誤読されないための但し書きは必須
  assert.match(tilt.caveat, /成績ではない/);
  assert.match(tilt.caveat, /未来の情報/);
});

test("群の傾斜: 構成銘柄が少なすぎれば作らない", () => {
  const factors = makeFactors(300);
  const members = [{ symbol: "A", bars: barsFromFactors(factors, { mkt: 1 }) }];
  assert.equal(attributeGroup(members, factors, "少数", 250), null);
});
