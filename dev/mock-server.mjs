import http from "node:http";
import fs from "node:fs";

/*
 * ダッシュボード描画確認用のモック API サーバー。
 *
 *   node dev/mock-server.mjs   →  http://127.0.0.1:8787
 *
 * public/index.html をそのまま配信し、/api/* に固定のダミー JSON を返す。
 * 外部 API にも Cloudflare にも触らないので、ネットワークが無くても
 * ダッシュボードの見た目・レイアウト・スマホ表示を確認できる。
 *
 * 数値は形を本物に合わせただけの合成データで、市場の実態とは無関係。
 * 型定義を変えたらここも手で追随させる必要がある (意図的に手書きにしている:
 * 本体のコードを import すると、壊れた実装でも「動いているように見える」
 * モックができてしまう)。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");

const REGIONS = [
  { id: "US", nameJa: "米国", nameEn: "United States", benchmark: "^GSPC", count: 62 },
  { id: "JP", nameJa: "日本", nameEn: "Japan", benchmark: "^N225", count: 29 },
  { id: "EU", nameJa: "欧州", nameEn: "Europe", benchmark: "^STOXX50E", count: 15 },
];
const SECTORS = [
  { id: "tech", nameJa: "情報技術", nameEn: "Information Technology", count: 8 },
  { id: "semis", nameJa: "半導体", nameEn: "Semiconductors", count: 7 },
  { id: "financials", nameJa: "金融", nameEn: "Financials", count: 5 },
  { id: "energy", nameJa: "エネルギー", nameEn: "Energy", count: 5 },
  { id: "health", nameJa: "ヘルスケア", nameEn: "Health Care", count: 6 },
  { id: "staples", nameJa: "生活必需品", nameEn: "Consumer Staples", count: 5 },
];

const spark = (n, base) =>
  Array.from({ length: n }, (_, i) => base * (1 + 0.15 * Math.sin(i / 7) + i * 0.001));

function sector(region, id, nameJa, heat, r1m) {
  return {
    region, sector: id, nameJa, nameEn: id, proxySymbol: "XLK", memberCount: 6,
    r1w: r1m / 4, r1m, r3m: r1m * 2.1, r12m: r1m * 6,
    medianPE: 22.4, medianForwardPE: 19.1, medianPB: 4.2, medianEvEbitda: 15.3,
    medianDividendYield: 0.017, medianROE: 0.21, medianRevenueGrowth: 0.11,
    meanTechnical: heat, meanRsi: 55.2, pctAbove200dma: 72,
    medianComposite: heat, sentiment: null, heat, spark: spark(60, 100),
  };
}

const sectors = [];
for (const r of REGIONS) {
  SECTORS.forEach((s, i) =>
    sectors.push(sector(r.id, s.id, s.nameJa, 70 - i * 7, 0.045 - i * 0.018))
  );
}

const row = (sym, ja, i) => ({
  "instrument.symbol": sym, "instrument.nameJa": ja, "instrument.name": sym,
  "instrument.region": "US", "instrument.sector": "tech", "instrument.role": "constituent",
  "price.last": 180 + i * 13, "price.currency": "USD",
  "price.r1d": 0.012 - i * 0.004, "price.r1w": 0.02, "price.r1m": 0.031 - i * 0.01,
  "price.r3m": 0.087 - i * 0.02, "price.r12m": 0.24 - i * 0.03, "price.ytd": 0.11,
  "price.rangePosition52w": 0.86, "technicals.rsi14": 58 - i * 3,
  "technicals.compositeScore": 74 - i * 5, "risk.vol252": 0.26, "risk.beta": 1.15,
  "risk.maxDrawdown": -0.22, "fundamentals.trailingPE": 28.3 + i,
  "fundamentals.forwardPE": 24.1 + i, "fundamentals.priceToBook": 6.4,
  "fundamentals.evToEbitda": 18.2, "fundamentals.dividendYield": 0.006,
  "fundamentals.returnOnEquity": 0.31, "fundamentals.operatingMargin": 0.29,
  "fundamentals.revenueGrowth": 0.14, "fundamentals.debtToEquity": 48,
  "consensus.upsideToTarget": 0.18, "factors.composite": 78 - i * 4,
  "factors.value": 42, "factors.quality": 88, "factors.momentum": 71,
  "factors.growth": 66, "factors.lowVol": 54, "factors.rank": i + 1,
});

const leaders = {
  total: 25, returned: 6, fields: [], query: {},
  rows: [["AAPL", "アップル"], ["MSFT", "マイクロソフト"], ["NVDA", "エヌビディア"],
         ["7203.T", "トヨタ自動車"], ["ASML.AS", "ASML"], ["JPM", "JPモルガン"]]
    .map(([s, j], i) => row(s, j, i)),
};

const macro = {
  total: 6, returned: 6, fields: [], query: {},
  rows: [["^GSPC", "S&P 500", 5820], ["^N225", "日経平均", 39240], ["^VIX", "VIX恐怖指数", 14.2],
         ["^TNX", "米10年金利", 4.21], ["GC=F", "金先物", 2680], ["CL=F", "WTI原油", 71.4]]
    .map(([s, j, p], i) => ({
      "instrument.symbol": s, "instrument.nameJa": j, "instrument.region": "US",
      "instrument.assetClass": "index", "price.last": p, "price.currency": "USD",
      "price.r1d": 0.008 - i * 0.004, "price.r1w": 0.01, "price.r1m": 0.022 - i * 0.01,
      "price.r3m": 0.05, "price.ytd": 0.14 - i * 0.03,
      "price.rangePosition52w": 0.78, "technicals.rsi14": 61,
    })),
};

const rotation = ["情報技術", "半導体", "金融", "エネルギー", "ヘルスケア", "生活必需品"].map((n, i) => {
  const rr = 104 - i * 3.2, rm = 103 - i * 2.4;
  return {
    symbol: ["XLK", "SMH", "XLF", "XLE", "XLV", "XLP"][i], name: n,
    sector: "tech", region: "US", rsRatio: rr, rsMomentum: rm,
    quadrant: rr >= 100 ? (rm >= 100 ? "leading" : "weakening") : (rm >= 100 ? "improving" : "lagging"),
    trail: Array.from({ length: 6 }, (_, k) => ({ rsRatio: rr - (5 - k) * 0.8, rsMomentum: rm - (5 - k) * 0.5 })),
  };
});

const corrSyms = ["XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLU", "GLD", "TLT", "^GSPC"];
const corrLabels = ["米国 情報技術", "米国 金融", "米国 エネルギー", "米国 ヘルスケア",
  "米国 一般消費財", "米国 生活必需品", "米国 公益", "金 (ゴールド)", "米長期国債ETF", "S&P 500"];
const n = corrSyms.length;
const matrix = [];
for (let i = 0; i < n; i++)
  for (let j = 0; j < n; j++)
    matrix.push(i === j ? 1 : Math.round((0.75 - Math.abs(i - j) * 0.14) * 100) / 100);

const overview = {
  generatedAt: new Date().toISOString(), version: "1.0.0",
  regime: {
    asOf: new Date().toISOString(), trend: "bull", trendConfidence: 0.78,
    volatility: "normal", riskAppetite: "risk-on",
    evidence: [
      { name: "S&P500 対 200日線", value: 0.084, reading: "200日線の上 (上昇基調)" },
      { name: "50日線 / 200日線", value: null, reading: "ゴールデンクロス" },
      { name: "S&P500 ADX(14)", value: 27.3, reading: "トレンド継続中 (方向: 上)" },
      { name: "200日線超えの銘柄比率", value: 68, reading: "68% — 上昇の裾野は広い" },
      { name: "VIX", value: 14.2, reading: "14.2 (52週レンジ内 22%) — 平常" },
      { name: "信用スプレッド代理 (HYG − LQD, 3ヶ月)", value: 0.011, reading: "1.10pt — ハイイールドが投資適格に優位 (リスク選好)" },
    ],
    playbook: [
      "順張りが機能しやすい地形。モメンタム上位・200日線上の銘柄を軸に。",
      "バリュエーションの割高さは短期では効きにくい。撤退ルールを価格 (移動平均割れ) で持つ。",
    ],
  },
  breadth: [
    { scope: "グローバル", count: 118, pctAbove50dma: 71, pctAbove200dma: 68, advancers: 79, decliners: 39, advanceDeclineRatio: 2.03, newHighs52w: 12, newLows52w: 2, meanRsi: 57.1, label: "broad-rally" },
    { scope: "米国", count: 58, pctAbove50dma: 74, pctAbove200dma: 72, advancers: 41, decliners: 17, advanceDeclineRatio: 2.41, newHighs52w: 8, newLows52w: 1, meanRsi: 58.9, label: "broad-rally" },
    { scope: "日本", count: 27, pctAbove50dma: 63, pctAbove200dma: 59, advancers: 17, decliners: 10, advanceDeclineRatio: 1.7, newHighs52w: 3, newLows52w: 1, meanRsi: 54.2, label: "mixed" },
  ],
  sectors, rotation,
  correlation: {
    symbols: corrSyms, labels: corrLabels, matrix, window: 126,
    meanPairwise: 0.41, pc1Share: 0.52,
    pc1Loadings: corrSyms.map((_, i) => 0.42 - i * 0.03),
    clusters: [
      { id: 0, symbols: ["XLK", "XLY", "^GSPC"] },
      { id: 1, symbols: ["XLE", "XLF"] },
      { id: 2, symbols: ["GLD", "TLT"] },
      { id: 3, symbols: ["XLP", "XLU", "XLV"] },
    ],
  },
  news: Array.from({ length: 10 }, (_, i) => ({
    title: `半導体大手が四半期見通しを上方修正、AI向け需要が想定を上回る (${i + 1})`,
    link: "https://example.com/", pubDate: "Thu, 06 Aug 2026 07:00:00 GMT",
    source: ["Yahoo Finance", "CNBC Markets", "NHK 経済"][i % 3],
  })),
  leaders, laggards: { total: 10, returned: 0, fields: [], rows: [], query: {} }, macro,
  meta: {
    universeSize: 135, covered: 118, shard: 3, shards: 8, fetches: 41,
    aiModel: "@cf/meta/llama-3.1-8b-instruct",
    dataSources: ["yahoo-finance", "stooq", "rss"], elapsedMs: 2410,
    errors: ["budget-skip:chart:EWC", "fundamentals:INFY.NS:取得不可"],
  },
};

const bars = Array.from({ length: 260 }, (_, i) => {
  const c = 150 * (1 + 0.28 * Math.sin(i / 30) + i * 0.0016);
  return { t: 1754000000 - (259 - i) * 86400, o: c * 0.998, h: c * 1.012, l: c * 0.988, c, v: 4e7 + 2e7 * Math.abs(Math.sin(i / 5)) };
});

const record = {
  instrument: { symbol: "AAPL", name: "Apple", nameJa: "アップル", region: "US", sector: "tech", role: "constituent", assetClass: "equity", currency: "USD" },
  asOf: new Date().toISOString(),
  price: { last: 231.44, previousClose: 228.7, r1d: 0.012, r1w: 0.021, r1m: 0.038, r3m: 0.092, r6m: 0.15, r12m: 0.27, ytd: 0.13, r12m1m: 0.23, high52w: 241.2, low52w: 164.1, rangePosition52w: 0.87, drawdownFrom52wHigh: -0.041, avgVolume20d: 52400000, volumeRatio: 1.34, currency: "USD" },
  technicals: {
    rsi14: 61.4, rsi14State: "neutral", rsiDivergence: "none",
    ma: { sma5: 229.1, sma20: 224.3, sma50: 218.7, sma100: 209.4, sma200: 198.2, ema12: 228.0, ema26: 222.6, above: { sma20: true, sma50: true, sma200: true }, deviation200: 0.168, cross: "golden", crossAgeDays: 84, perfectOrder: "bullish" },
    macd: { macd: 3.412, signal: 2.877, histogram: 0.535, crossAgeDays: 12, state: "bullish" },
    bollinger: { middle: 224.3, upper: 236.8, lower: 211.8, percentB: 0.78, bandwidth: 0.111, bandwidthPercentile: 34, squeeze: false },
    atr14: 4.12, atrPercent: 0.0178,
    stochastic: { k: 74.2, d: 69.8, state: "neutral" },
    adx: { adx: 28.4, plusDi: 26.1, minusDi: 13.7, regime: "trending", direction: "up" },
    obvSlope20: 0.14, mfi14: 63.1, cci20: 118, williamsR14: -24.3, roc20: 0.041,
    vwap20: 226.8, vwapDeviation: 0.02,
    pivots: { pivot: 229.9, r1: 234.1, r2: 238.0, r3: 242.2, s1: 226.0, s2: 221.8, s3: 217.7, method: "classic" },
    fibPivots: { pivot: 229.9, r1: 232.2, r2: 233.7, r3: 236.0, s1: 227.6, s2: 226.1, s3: 223.8, method: "fibonacci" },
    levels: {
      resistance: [{ level: 238.4, touches: 3, distancePct: 0.03 }, { level: 241.2, touches: 2, distancePct: 0.042 }],
      support: [{ level: 224.1, touches: 4, distancePct: -0.032 }, { level: 214.6, touches: 2, distancePct: -0.073 }],
    },
    upDayRatio20: 0.6, compositeScore: 76.4, compositeLabel: "strong-buy",
    breakdown: [
      { indicator: "RSI(14)", verdict: "bull", note: "61.4 — 中立圏" },
      { indicator: "200日線", verdict: "bull", note: "終値は200日線の上 (乖離 16.8%)" },
      { indicator: "50日線", verdict: "bull", note: "終値は50日線の上" },
      { indicator: "50/200クロス", verdict: "bull", note: "ゴールデンクロス (84営業日前)" },
      { indicator: "MACD", verdict: "bull", note: "ヒストグラム +0.535 / 12営業日前に転換" },
      { indicator: "ADX(14)", verdict: "bull", note: "ADX 28.4 (トレンド) / +DI 26.1 vs -DI 13.7" },
    ],
  },
  risk: { vol20: 0.221, vol60: 0.238, vol252: 0.264, volRatio: 0.837, downsideDeviation: 0.181, beta: 1.14, alphaAnnual: 0.062, rSquared: 0.61, correlationToBenchmark: 0.781, trackingError: 0.164, informationRatio: 0.38, upCapture: 1.12, downCapture: 0.94, maxDrawdown: -0.184, maxDrawdownDays: 47, currentDrawdown: -0.041, sharpe: 0.92, sortino: 1.34, calmar: 1.32, var95: 0.0241, var99: 0.0412, cvar95: 0.0338, cvar99: 0.0521, skewness: -0.21, kurtosis: 1.84, tailDays: 11, benchmark: "^GSPC", riskFreeAssumption: "無リスク金利 0% (通貨横断での相対比較を優先)" },
  fundamentals: {
    symbol: "AAPL", asOf: new Date().toISOString(), source: "yahoo:quoteSummary", currency: "USD",
    marketCap: 3.51e12, enterpriseValue: 3.56e12, trailingPE: 34.2, forwardPE: 29.8, pegRatio: 2.6,
    priceToBook: 51.2, priceToSales: 8.9, evToEbitda: 25.4, dividendYield: 0.0044, payoutRatio: 0.15,
    returnOnEquity: 1.47, returnOnAssets: 0.22, operatingMargin: 0.315, grossMargin: 0.462,
    profitMargin: 0.247, debtToEquity: 145, currentRatio: 0.87, revenueGrowth: 0.061,
    earningsGrowth: 0.11, earningsQuarterlyGrowth: 0.13, revenue3yCagr: 0.048,
    fieldSources: { trailingPE: "yahoo:summaryDetail", priceToBook: "yahoo:defaultKeyStatistics", earningsYield: "derived:1/PER", returnOnInvestedCapital: "derived:NOPAT/投下資本 (実効税率25%仮定)" },
  },
  consensus: { symbol: "AAPL", asOf: new Date().toISOString(), source: "yahoo:quoteSummary", recommendationMean: 1.9, recommendationKey: "buy", analystCount: 41, targetMean: 262.4, targetHigh: 310, targetLow: 190, targetMedian: 265, upsideToTarget: 0.134, targetDispersion: 0.457, trend: [{ period: "0m", strongBuy: 14, buy: 18, hold: 8, sell: 1, strongSell: 0 }, { period: "-1m", strongBuy: 13, buy: 18, hold: 9, sell: 1, strongSell: 0 }, { period: "-3m", strongBuy: 11, buy: 17, hold: 11, sell: 2, strongSell: 0 }], ratingMomentum: 0.19, epsRevision: { period: "0q", up: 7, down: 2 } },
  valuation: { score: 38.2, coverage: 0.78, metrics: [
    { key: "trailingPE", label: "PER (実績)", value: 34.2, z: -0.8, percentile: 22, peerMedian: 26.4, lowerIsBetter: true, unit: "x" },
    { key: "forwardPE", label: "PER (予想)", value: 29.8, z: -0.6, percentile: 28, peerMedian: 23.1, lowerIsBetter: true, unit: "x" },
    { key: "priceToBook", label: "PBR", value: 51.2, z: -1.4, percentile: 8, peerMedian: 6.2, lowerIsBetter: true, unit: "x" },
    { key: "dividendYield", label: "配当利回り", value: 0.0044, z: -0.3, percentile: 41, peerMedian: 0.009, lowerIsBetter: false, unit: "%" },
  ] },
  quality: { score: 91.4, coverage: 0.8, metrics: [
    { key: "returnOnEquity", label: "ROE", value: 1.47, z: 2.2, percentile: 98, peerMedian: 0.24, lowerIsBetter: false, unit: "%" },
    { key: "operatingMargin", label: "営業利益率", value: 0.315, z: 1.4, percentile: 86, peerMedian: 0.19, lowerIsBetter: false, unit: "%" },
    { key: "debtToEquity", label: "D/Eレシオ", value: 145, z: -0.7, percentile: 28, peerMedian: 62, lowerIsBetter: true, unit: "ratio" },
  ] },
  growth: { score: 44.1, coverage: 0.6, metrics: [
    { key: "revenueGrowth", label: "売上成長率 (前年比)", value: 0.061, z: -0.4, percentile: 36, peerMedian: 0.108, lowerIsBetter: false, unit: "%" },
    { key: "earningsGrowth", label: "利益成長率 (前年比)", value: 0.11, z: -0.1, percentile: 47, peerMedian: 0.12, lowerIsBetter: false, unit: "%" },
  ] },
  factors: { value: 38, quality: 91, momentum: 74, growth: 44, lowVol: 58, composite: 68.4, coverage: 1, rank: 7, peerCount: 101, contributions: [
    { factor: "value", weight: 0.25, z: -0.61, contribution: -0.15 },
    { factor: "quality", weight: 0.25, z: 2.05, contribution: 0.51 },
    { factor: "momentum", weight: 0.25, z: 1.19, contribution: 0.3 },
    { factor: "growth", weight: 0.15, z: -0.3, contribution: -0.04 },
    { factor: "lowVol", weight: 0.1, z: 0.4, contribution: 0.04 },
  ] },
  signals: [
    { id: "quality-momentum", category: "momentum", direction: "bullish", strength: 3, title: "クオリティ × モメンタムの合致", detail: "クオリティ 91点 / モメンタム 74点。実証的に最も頑健とされる組み合わせ (総合7位 / 101銘柄)。" },
    { id: "adx-trend", category: "technical", direction: "bullish", strength: 2, title: "明確な上昇トレンド", detail: "ADX 28.4 (25超でトレンド)。+DI 26.1 / -DI 13.7。順張りが機能しやすい状態。" },
    { id: "rich-forward-pe", category: "valuation", direction: "caution", strength: 2, title: "予想PERがセクター内で割高", detail: "予想PER 29.8倍 (セクター中央値 23.1倍)。成長が続く前提が既に価格に入っている。" },
    { id: "volume-spike", category: "technical", direction: "bullish", strength: 2, title: "出来高急増", detail: "直近出来高は20日平均の1.3倍。当日リターン +1.2%。何らかの材料が出ている可能性が高い。" },
  ],
  spark: spark(120, 200),
  dataQuality: { bars: 504, priceSource: "yahoo", fundamentalsSource: "yahoo:quoteSummary", lastBarDate: "2026-08-05", warnings: [] },
};

const peers = [["MSFT", "マイクロソフト"], ["NVDA", "エヌビディア"], ["ORCL", "オラクル"]].map(([s, j], i) => ({
  symbol: s, nameJa: j, region: "US", forwardPE: 26 + i * 3, priceToBook: 12 + i * 4,
  returnOnEquity: 0.34 - i * 0.05, r3m: 0.07 - i * 0.02, composite: 74 - i * 6,
}));

const routes = {
  "/api/overview": overview,
  "/api/universe": { version: "1.0.0", size: 135, regions: REGIONS, sectors: SECTORS, instruments: [] },
  "/api/presets": {
    fields: [],
    presets: [
      { id: "deep-value", nameJa: "ディープバリュー", description: "PBR 1.5倍以下 × 予想PER 15倍以下 × 営業黒字。安いだけの銘柄を除くため利益率で足切りしている。", query: {} },
      { id: "quality-momentum", nameJa: "クオリティ × モメンタム", description: "ROE 15%以上 × 200日線の上 × 12-1モメンタム上位。実証的に最も頑健とされる組み合わせ。", query: {} },
      { id: "dividend-safety", nameJa: "高配当 × 配当余力", description: "配当利回り 3%以上 × 配当性向 70%以下 × D/E 150%以下。", query: {} },
      { id: "breakout", nameJa: "ブレイクアウト候補", description: "52週レンジ上位10% × ADX 25以上 × 出来高が20日平均超。", query: {} },
    ],
  },
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const json = (o) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(o));
  };
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(HTML));
  }
  if (routes[p]) return json(routes[p]);
  if (p === "/api/screener") return json({ generatedAt: overview.generatedAt, total: 6, returned: 6, fields: [], rows: leaders.rows, query: {} });
  if (p.startsWith("/api/symbol/")) return json({ generatedAt: overview.generatedAt, record, peers });
  if (p.startsWith("/api/history/")) return json({ symbol: "AAPL", name: "Apple", currency: "USD", source: "yahoo", fetchedAt: overview.generatedAt, bars });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"error":"not found"}');
}).listen(8787, () => console.log("QAIZ mock: http://127.0.0.1:8787"));
