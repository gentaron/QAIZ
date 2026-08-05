import test from "node:test";
import assert from "node:assert/strict";
import {
  GROWTH_METRICS,
  QUALITY_METRICS,
  VALUATION_METRICS,
  buildScorecards,
  deriveFundamentals,
} from "../src/analytics/fundamentals.ts";
import {
  DEFAULT_FACTOR_WEIGHTS,
  computeFactors,
  parseWeights,
} from "../src/analytics/factors.ts";
import { generateSignals } from "../src/analytics/signals.ts";
import type { Consensus, Fundamentals, PriceSummary, RiskMetrics } from "../src/types.ts";

function fundamentals(partial: Partial<Fundamentals>): Fundamentals {
  return {
    symbol: partial.symbol ?? "TEST",
    asOf: "2026-08-05T00:00:00.000Z",
    source: "test",
    currency: "USD",
    marketCap: null, enterpriseValue: null, sharesOutstanding: null, floatShares: null,
    trailingPE: null, forwardPE: null, pegRatio: null, priceToBook: null, priceToSales: null,
    evToEbitda: null, evToSales: null, evToFcf: null, earningsYield: null, fcfYield: null,
    dividendYield: null, payoutRatio: null, buybackYield: null,
    returnOnEquity: null, returnOnAssets: null, returnOnInvestedCapital: null,
    grossMargin: null, operatingMargin: null, profitMargin: null, ebitdaMargin: null,
    debtToEquity: null, netDebtToEbitda: null, currentRatio: null, quickRatio: null,
    interestCoverage: null, totalCash: null, totalDebt: null,
    revenueGrowth: null, earningsGrowth: null, earningsQuarterlyGrowth: null, revenue3yCagr: null,
    beta: null, shortPercentOfFloat: null, heldPercentInstitutions: null, heldPercentInsiders: null,
    trailingEps: null, forwardEps: null, bookValuePerShare: null, revenuePerShare: null,
    revenueValue: null, ebitdaValue: null, ebitValue: null, freeCashflowValue: null,
    operatingCashflowValue: null, totalEquityValue: null, interestExpenseValue: null,
    fieldSources: {},
    ...partial,
  };
}

const priceStub = (over: Partial<PriceSummary> = {}): PriceSummary => ({
  last: 100, previousClose: 99, r1d: 0.01, r1w: 0.02, r1m: 0.03, r3m: 0.05, r6m: 0.08,
  r12m: 0.12, ytd: 0.06, r12m1m: 0.1, high52w: 110, low52w: 80, rangePosition52w: 0.66,
  drawdownFrom52wHigh: -0.09, avgVolume20d: 1e6, volumeRatio: 1, currency: "USD", ...over,
});

const riskStub = (over: Partial<RiskMetrics> = {}): RiskMetrics => ({
  vol20: 0.2, vol60: 0.2, vol252: 0.22, volRatio: 0.9, downsideDeviation: 0.15,
  beta: 1, alphaAnnual: 0.01, rSquared: 0.6, correlationToBenchmark: 0.77, trackingError: 0.1,
  informationRatio: 0.1, upCapture: 1, downCapture: 1, maxDrawdown: -0.2, maxDrawdownDays: 40,
  currentDrawdown: -0.05, sharpe: 0.5, sortino: 0.7, calmar: 0.4, var95: 0.02, var99: 0.04,
  cvar95: 0.03, cvar99: 0.05, skewness: -0.1, kurtosis: 1, tailDays: 10,
  benchmark: "^GSPC", riskFreeAssumption: "test", ...over,
});

test("スコアカード: 小さいほど良い指標は符号反転して評価される", () => {
  // PER だけを変えた 6 銘柄。PER が低い銘柄ほど高いスコアになるはず。
  const peers = [5, 10, 15, 20, 30, 60].map((pe, i) => ({
    symbol: `S${i}`,
    fundamentals: fundamentals({
      symbol: `S${i}`,
      trailingPE: pe,
      forwardPE: pe,
      priceToBook: pe / 10,
      priceToSales: pe / 5,
      evToEbitda: pe * 0.8,
    }),
    consensus: null,
  }));
  const cards = buildScorecards(peers, VALUATION_METRICS);
  const cheap = cards.get("S0")!;
  const rich = cards.get("S5")!;
  assert.ok(cheap.score! > rich.score!, `割安側 ${cheap.score} ≤ 割高側 ${rich.score}`);
  // メトリクスには生値と中央値の両方が残る
  const m = cheap.metrics.find((x) => x.key === "trailingPE")!;
  assert.equal(m.value, 5);
  assert.equal(m.lowerIsBetter, true);
  assert.ok(m.peerMedian !== null);
  assert.equal(m.percentile, 100);
});

test("スコアカード: 定義域外 (赤字企業の負のPER) は欠損扱いにする", () => {
  const peers = [-20, 8, 12, 16, 24, 400].map((pe, i) => ({
    symbol: `S${i}`,
    fundamentals: fundamentals({ symbol: `S${i}`, trailingPE: pe }),
    consensus: null,
  }));
  const cards = buildScorecards(peers, VALUATION_METRICS);
  // 負の PER と 400 倍はどちらも定義域外 → value が null
  assert.equal(cards.get("S0")!.metrics.find((m) => m.key === "trailingPE")!.value, null);
  assert.equal(cards.get("S5")!.metrics.find((m) => m.key === "trailingPE")!.value, null);
  assert.ok(cards.get("S1")!.metrics.find((m) => m.key === "trailingPE")!.value === 8);
});

test("スコアカード: カバレッジが 30% 未満ならスコアを出さない", () => {
  // 9 指標中 1 つしか無い → カバレッジ 11%
  const peers = Array.from({ length: 6 }, (_, i) => ({
    symbol: `S${i}`,
    fundamentals: fundamentals({ symbol: `S${i}`, trailingPE: 10 + i }),
    consensus: null,
  }));
  const cards = buildScorecards(peers, VALUATION_METRICS);
  assert.equal(cards.get("S0")!.score, null);
  assert.ok(cards.get("S0")!.coverage < 0.3);
});

test("スコアカード: クオリティは大きいほど良い指標が正しく効く", () => {
  const peers = [0.02, 0.08, 0.12, 0.18, 0.25, 0.35].map((roe, i) => ({
    symbol: `S${i}`,
    fundamentals: fundamentals({
      symbol: `S${i}`,
      returnOnEquity: roe,
      returnOnAssets: roe / 2,
      operatingMargin: roe,
      profitMargin: roe * 0.7,
      debtToEquity: 50,
    }),
    consensus: null,
  }));
  const cards = buildScorecards(peers, QUALITY_METRICS);
  assert.ok(cards.get("S5")!.score! > cards.get("S0")!.score!);
});

test("成長スコアはコンセンサスのレーティング改定も取り込む", () => {
  const mk = (i: number, g: number, rm: number) => ({
    symbol: `S${i}`,
    fundamentals: fundamentals({ symbol: `S${i}`, revenueGrowth: g, earningsGrowth: g, revenue3yCagr: g }),
    consensus: { ratingMomentum: rm } as Consensus,
  });
  const peers = [mk(0, 0.02, -0.5), mk(1, 0.05, 0), mk(2, 0.1, 0), mk(3, 0.2, 0.2), mk(4, 0.3, 0.4), mk(5, 0.4, 0.6)];
  const cards = buildScorecards(peers, GROWTH_METRICS);
  assert.ok(cards.get("S5")!.score! > cards.get("S0")!.score!);
  assert.ok(cards.get("S0")!.metrics.some((m) => m.key === "ratingMomentum" && m.value === -0.5));
});

test("派生指標: 益利回り・FCF利回り・ネット負債倍率を導出し、出所を残す", () => {
  const f = deriveFundamentals(
    fundamentals({
      trailingPE: 20,
      marketCap: 1000,
      enterpriseValue: 1200,
      freeCashflowValue: 50,
      ebitdaValue: 200,
      revenueValue: 800,
      totalDebt: 300,
      totalCash: 100,
      ebitValue: 150,
      totalEquityValue: 700,
      interestExpenseValue: 30,
    })
  );
  assert.ok(Math.abs(f.earningsYield! - 0.05) < 1e-12);
  assert.ok(Math.abs(f.fcfYield! - 0.05) < 1e-12);
  assert.ok(Math.abs(f.evToFcf! - 24) < 1e-12);
  assert.ok(Math.abs(f.ebitdaMargin! - 0.25) < 1e-12);
  assert.ok(Math.abs(f.netDebtToEbitda! - 1) < 1e-12);
  assert.ok(Math.abs(f.evToSales! - 1.5) < 1e-12);
  assert.ok(Math.abs(f.interestCoverage! - 5) < 1e-12);
  // ROIC = EBIT × (1 - 25%) / (負債 + 自己資本)
  assert.ok(Math.abs(f.returnOnInvestedCapital! - (150 * 0.75) / 1000) < 1e-12);
  // 仮定を置いた指標は必ず出所に残す
  assert.match(f.fieldSources.returnOnInvestedCapital, /実効税率25%/);
});

test("派生指標: 実測値があれば上書きしない", () => {
  const f = deriveFundamentals(fundamentals({ trailingPE: 20, earningsYield: 0.09 }));
  assert.equal(f.earningsYield, 0.09);
  assert.equal(f.fieldSources.earningsYield, undefined);
});

test("ファクター: モメンタムは 12-1 が高い銘柄を上位にする", () => {
  const inputs = [0.5, 0.3, 0.1, -0.1, -0.3, -0.5].map((m, i) => ({
    symbol: `S${i}`,
    price: priceStub({ r12m1m: m, r3m: m / 2, r1m: 0, rangePosition52w: 0.5 + m / 2 }),
    // 全員同じリスクだと低ボラファクターが定数列になり Z が取れない。
    // 総合スコアが付く条件 (使えるウェイト 3 割以上) を満たすため散らす。
    risk: riskStub({ vol252: 0.2 + i * 0.01, maxDrawdown: -0.2 - i * 0.01 }),
    valuation: null,
    quality: null,
    growth: null,
    technicalScore: 50,
    above200dma: m > 0,
  }));
  const f = computeFactors(inputs);
  assert.ok(f.get("S0")!.momentum! > f.get("S5")!.momentum!);
  assert.equal(f.get("S0")!.rank, 1);
  assert.equal(f.get("S0")!.peerCount, 6);
});

test("ファクター: 短期リバーサル (直近1ヶ月の急騰) は減点される", () => {
  const base = (i: number, r1m: number) => ({
    symbol: `S${i}`,
    price: priceStub({ r12m1m: 0.2, r3m: 0.1, r1m, rangePosition52w: 0.7 }),
    risk: riskStub(),
    valuation: null, quality: null, growth: null,
    technicalScore: 50, above200dma: true,
  });
  const inputs = [base(0, -0.1), base(1, -0.05), base(2, 0), base(3, 0.05), base(4, 0.1), base(5, 0.3)];
  const f = computeFactors(inputs);
  assert.ok(
    f.get("S0")!.momentum! > f.get("S5")!.momentum!,
    "直近1ヶ月で急騰した銘柄のモメンタムが下がっていない"
  );
});

test("ファクター: 低ボラは年率ボラが低いほど高い", () => {
  const inputs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.8].map((v, i) => ({
    symbol: `S${i}`,
    price: priceStub(),
    risk: riskStub({ vol252: v, maxDrawdown: -v, downCapture: v * 3 }),
    valuation: null, quality: null, growth: null,
    technicalScore: 50, above200dma: true,
  }));
  const f = computeFactors(inputs);
  assert.ok(f.get("S0")!.lowVol! > f.get("S5")!.lowVol!);
});

test("ファクター: ETF のようにファンダが無い銘柄も coverage 付きで順位が付く", () => {
  const inputs = [0.4, 0.2, 0.0, -0.2, -0.4, -0.6].map((m, i) => ({
    symbol: `E${i}`,
    price: priceStub({ r12m1m: m, r3m: m / 2, r1m: 0 }),
    risk: riskStub({ vol252: 0.2 + i * 0.02 }),
    valuation: null, quality: null, growth: null,
    technicalScore: 50, above200dma: true,
  }));
  const f = computeFactors(inputs);
  const top = f.get("E0")!;
  assert.ok(top.composite !== null, "ETF に総合スコアが付いていない");
  assert.equal(top.rank, 1);
  // 勢い + 低ボラのみなので coverage は既定ウェイトの 0.35
  assert.ok(Math.abs(top.coverage - 0.35) < 1e-9, `coverage=${top.coverage}`);
  assert.equal(top.value, null);
  assert.equal(top.quality, null);
});

test("ファクター: 使えるファクターが 3 割未満なら総合スコアを付けない", () => {
  const inputs = Array.from({ length: 6 }, (_, i) => ({
    symbol: `S${i}`,
    price: priceStub({ r12m1m: null, r3m: null, r1m: null, rangePosition52w: null }),
    risk: riskStub({ vol252: null, maxDrawdown: null, downCapture: null }),
    valuation: null, quality: null, growth: null,
    technicalScore: null, above200dma: null,
  }));
  const f = computeFactors(inputs);
  assert.equal(f.get("S0")!.composite, null);
  assert.equal(f.get("S0")!.rank, null);
});

test("ファクターウェイトは正規化され、不正な JSON は既定値に落ちる", () => {
  const w = parseWeights('{"value":2,"quality":2,"momentum":0,"growth":0,"lowVol":0}');
  assert.ok(Math.abs(w.value - 0.5) < 1e-12);
  assert.ok(Math.abs(w.quality - 0.5) < 1e-12);
  assert.equal(w.momentum, 0);
  assert.deepEqual(parseWeights("これはJSONではない"), DEFAULT_FACTOR_WEIGHTS);
  assert.deepEqual(parseWeights(undefined), DEFAULT_FACTOR_WEIGHTS);
});

test("シグナル: 全項目に数値の根拠が入る", () => {
  const sigs = generateSignals({
    price: priceStub({ volumeRatio: 3, rangePosition52w: 0.99, r1d: 0.05 }),
    technicals: {
      rsi14: 78, rsi14State: "overbought", rsiDivergence: "bearish",
      ma: {
        sma5: 100, sma20: 98, sma50: 95, sma100: 92, sma200: 90, ema12: 99, ema26: 97,
        above: { sma20: true, sma50: true, sma200: true },
        deviation200: 0.11, cross: "golden", crossAgeDays: 10, perfectOrder: "bullish",
      },
      macd: { macd: 1, signal: 0.5, histogram: 0.5, crossAgeDays: 5, state: "bullish" },
      bollinger: { middle: 98, upper: 104, lower: 92, percentB: 0.9, bandwidth: 0.12, bandwidthPercentile: 12, squeeze: true },
      atr14: 2, atrPercent: 0.02,
      stochastic: { k: 85, d: 80, state: "overbought" },
      adx: { adx: 32, plusDi: 28, minusDi: 14, regime: "trending", direction: "up" },
      obvSlope20: 0.2, mfi14: 70, cci20: 150, williamsR14: -12, roc20: 0.06,
      vwap20: 97, vwapDeviation: 0.03,
      pivots: null, fibPivots: null,
      levels: { resistance: [{ level: 101, touches: 4, distancePct: 0.01 }], support: [] },
      upDayRatio20: 0.7, compositeScore: 80, compositeLabel: "strong-buy", breakdown: [],
    },
    risk: riskStub({ volRatio: 1.7, beta: 1.8, skewness: -0.8, kurtosis: 4 }),
    fundamentals: null,
    consensus: {
      symbol: "T", asOf: "", source: "t", recommendationMean: 1.8, recommendationKey: "buy",
      analystCount: 20, targetMean: 130, targetHigh: 180, targetLow: 90, targetMedian: 128,
      upsideToTarget: 0.3, targetDispersion: 0.69, trend: [], ratingMomentum: 0.3, epsRevision: null,
    },
    valuation: null, quality: null, growth: null, factors: null,
  });

  assert.ok(sigs.length > 5, `シグナルが少なすぎる: ${sigs.length}`);
  // 強い順に並ぶ
  for (let i = 1; i < sigs.length; i++) assert.ok(sigs[i - 1].strength >= sigs[i].strength);
  // 全シグナルに説明文がある
  for (const s of sigs) {
    assert.ok(s.detail.length > 10, `根拠が薄いシグナル: ${s.id}`);
    assert.ok(["bullish", "bearish", "caution"].includes(s.direction));
  }
  const ids = sigs.map((s) => s.id);
  assert.ok(ids.includes("golden-cross"));
  assert.ok(ids.includes("rsi-bear-div"));
  assert.ok(ids.includes("bb-squeeze"));
  assert.ok(ids.includes("volume-spike"));
  assert.ok(ids.includes("target-upside"));
  assert.ok(ids.includes("vol-expansion"));
  assert.ok(ids.includes("fat-left-tail"));
});

test("シグナル: バリュートラップ (割安 × 弱いモメンタム) を検出する", () => {
  const sigs = generateSignals({
    price: priceStub(),
    technicals: {
      rsi14: 45, rsi14State: "neutral", rsiDivergence: "none",
      ma: {
        sma5: null, sma20: null, sma50: null, sma100: null, sma200: null,
        ema12: null, ema26: null, above: { sma20: null, sma50: null, sma200: null },
        deviation200: null, cross: "none", crossAgeDays: null, perfectOrder: "none",
      },
      macd: null, bollinger: null, atr14: null, atrPercent: null, stochastic: null, adx: null,
      obvSlope20: null, mfi14: null, cci20: null, williamsR14: null, roc20: null,
      vwap20: null, vwapDeviation: null, pivots: null, fibPivots: null,
      levels: { resistance: [], support: [] }, upDayRatio20: null,
      compositeScore: 50, compositeLabel: "neutral", breakdown: [],
    },
    risk: riskStub(),
    fundamentals: null, consensus: null, valuation: null, quality: null, growth: null,
    factors: {
      value: 85, quality: 50, momentum: 20, growth: 40, lowVol: 50,
      composite: 55, coverage: 1, rank: 10, peerCount: 40, contributions: [],
    },
  });
  assert.ok(sigs.some((s) => s.id === "value-trap-risk"));
});
