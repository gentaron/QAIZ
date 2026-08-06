import type { Bar, Consensus, Fundamentals, Series } from "../types.ts";
import { deriveFundamentals } from "../analytics/fundamentals.ts";
import { httpGet, UA } from "./http.ts";

/**
 * Yahoo Finance 非公式 API (キー不要)。
 *
 * 2 種類使う:
 *   1. /v8/finance/chart      … OHLCV。認証不要で世界中の銘柄が引ける。
 *   2. /v10/finance/quoteSummary … PER/PBR/ROE/アナリスト予想。
 *      こちらは cookie + crumb が要る。fc.yahoo.com で cookie を貰い、
 *      /v1/test/getcrumb で crumb を取ってからクエリに載せる。
 *
 * crumb は失敗しうる (仕様変更・地域ブロック)。失敗したときに
 * **推定値で埋めない** ことを徹底する。ファンダメンタルズが取れなければ
 * fundamentals は null のままにし、UI 側で「取得不可」と出す。
 * 適当な数字を入れたスクリーナーは、無いより有害。
 */

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const SUMMARY = "https://query1.finance.yahoo.com/v10/finance/quoteSummary";
const CRUMB = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const COOKIE_SEED = "https://fc.yahoo.com/";

/* ------------------------------------------------------------------ */
/* 価格 (認証不要)                                                     */
/* ------------------------------------------------------------------ */

interface ChartResponse {
  chart: {
    result?: {
      meta: {
        symbol: string;
        shortName?: string;
        longName?: string;
        currency?: string;
        regularMarketPrice?: number;
      };
      timestamp?: number[];
      indicators: {
        quote: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
        adjclose?: { adjclose?: (number | null)[] }[];
      };
    }[];
    error?: { code: string; description: string } | null;
  };
}

/**
 * 日次 OHLCV。
 *
 * 終値は **配当・分割調整後 (adjclose)** を使い、高値/安値/始値は
 * 同じ調整比率をかけて揃える。生の終値でリターンを計算すると、
 * 配当落ちがそのまま「下落」として入り、高配当セクターのモメンタムが
 * 構造的に過小評価される。
 */
export async function fetchYahooChart(
  symbol: string,
  range = "2y"
): Promise<Series | null> {
  const url = `${CHART}/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div%2Csplit`;
  const res = await httpGet(url, { cacheTtl: 900 });
  if (!res || !res.ok) return null;

  let json: ChartResponse;
  try {
    json = (await res.json()) as ChartResponse;
  } catch {
    return null;
  }
  const r = json.chart?.result?.[0];
  if (!r || !r.timestamp) return null;

  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const bars: Bar[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close?.[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    const a = adj?.[i];
    const k = a != null && Number.isFinite(a) && c > 0 ? a / c : 1;
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const v = q.volume?.[i];
    bars.push({
      t: r.timestamp[i],
      o: o != null && Number.isFinite(o) ? o * k : c * k,
      h: h != null && Number.isFinite(h) ? h * k : c * k,
      l: l != null && Number.isFinite(l) ? l * k : c * k,
      c: c * k,
      v: v != null && Number.isFinite(v) ? v : null,
    });
  }
  if (bars.length < 30) return null;

  return {
    symbol,
    name: r.meta.shortName ?? r.meta.longName ?? symbol,
    currency: r.meta.currency ?? "",
    bars,
    source: "yahoo",
    fetchedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* crumb セッション                                                    */
/* ------------------------------------------------------------------ */

export interface YahooSession {
  cookie: string;
  crumb: string;
  obtainedAt: number;
}

function extractCookie(res: Response): string {
  // Workers は getSetCookie() を持つが、環境差があるので両対応にする
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  const list =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  const parts: string[] = [];
  for (const raw of list) {
    if (!raw) continue;
    // "A=B; Path=/; Domain=..." の先頭 name=value だけ拾う
    for (const chunk of raw.split(/,(?=[^;]+?=)/)) {
      const nv = chunk.split(";")[0]?.trim();
      if (nv && nv.includes("=")) parts.push(nv);
    }
  }
  return parts.join("; ");
}

/** cookie + crumb を 2 リクエストで取得する。失敗したら null */
export async function createYahooSession(): Promise<YahooSession | null> {
  const seed = await httpGet(COOKIE_SEED, { timeoutMs: 6000 });
  // fc.yahoo.com は 404 を返すが Set-Cookie は付いてくる。status は見ない。
  const cookie = seed ? extractCookie(seed) : "";
  if (!cookie) return null;

  const res = await httpGet(CRUMB, {
    headers: { Cookie: cookie, "User-Agent": UA },
    timeoutMs: 6000,
  });
  if (!res || !res.ok) return null;
  const crumb = (await res.text()).trim();
  // crumb は短いトークン。HTML が返ってきたら失敗とみなす
  if (!crumb || crumb.length > 32 || crumb.includes("<")) return null;
  return { cookie, crumb, obtainedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* quoteSummary                                                        */
/* ------------------------------------------------------------------ */

type YNum = number | { raw?: number; fmt?: string } | null | undefined;

function num(x: YNum): number | null {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const r = x.raw;
  return typeof r === "number" && Number.isFinite(r) ? r : null;
}

const MODULES = [
  "price",
  "summaryDetail",
  "defaultKeyStatistics",
  "financialData",
  "recommendationTrend",
  "earningsTrend",
  "incomeStatementHistory",
].join(",");

interface SummaryResponse {
  quoteSummary?: {
    result?: Record<string, unknown>[];
    error?: { code: string; description: string } | null;
  };
}

export interface QuoteSummary {
  fundamentals: Fundamentals | null;
  consensus: Consensus | null;
}

export async function fetchYahooQuoteSummary(
  symbol: string,
  session: YahooSession
): Promise<QuoteSummary | null> {
  const url =
    `${SUMMARY}/${encodeURIComponent(symbol)}?modules=${MODULES}` +
    `&crumb=${encodeURIComponent(session.crumb)}`;
  const res = await httpGet(url, {
    headers: { Cookie: session.cookie, "User-Agent": UA },
    cacheTtl: 3600,
  });
  if (!res || !res.ok) return null;

  let json: SummaryResponse;
  try {
    json = (await res.json()) as SummaryResponse;
  } catch {
    return null;
  }
  const r = json.quoteSummary?.result?.[0];
  if (!r) return null;

  return {
    fundamentals: parseFundamentals(symbol, r),
    consensus: parseConsensus(symbol, r),
  };
}

/* ------------------------------------------------------------------ */
/* パース                                                              */
/* ------------------------------------------------------------------ */

interface PriceModule { currency?: string; currencySymbol?: string }
interface SummaryDetail {
  trailingPE?: YNum; forwardPE?: YNum; dividendYield?: YNum; payoutRatio?: YNum;
  priceToSalesTrailing12Months?: YNum; marketCap?: YNum; beta?: YNum;
}
interface KeyStats {
  enterpriseValue?: YNum; forwardPE?: YNum; pegRatio?: YNum; priceToBook?: YNum;
  enterpriseToRevenue?: YNum; enterpriseToEbitda?: YNum; profitMargins?: YNum;
  trailingEps?: YNum; forwardEps?: YNum; bookValue?: YNum; beta?: YNum;
  sharesOutstanding?: YNum; floatShares?: YNum; heldPercentInsiders?: YNum;
  heldPercentInstitutions?: YNum; shortPercentOfFloat?: YNum; earningsQuarterlyGrowth?: YNum;
}
interface FinancialData {
  totalCash?: YNum; totalDebt?: YNum; debtToEquity?: YNum; currentRatio?: YNum;
  quickRatio?: YNum; totalRevenue?: YNum; revenuePerShare?: YNum; returnOnAssets?: YNum;
  returnOnEquity?: YNum; grossProfits?: YNum; freeCashflow?: YNum; operatingCashflow?: YNum;
  ebitda?: YNum; revenueGrowth?: YNum; earningsGrowth?: YNum; grossMargins?: YNum;
  operatingMargins?: YNum; profitMargins?: YNum; ebitdaMargins?: YNum;
  targetMeanPrice?: YNum; targetHighPrice?: YNum; targetLowPrice?: YNum;
  targetMedianPrice?: YNum; recommendationMean?: YNum; recommendationKey?: string;
  numberOfAnalystOpinions?: YNum; currentPrice?: YNum; financialCurrency?: string;
}
interface IncomeRow {
  totalRevenue?: YNum; ebit?: YNum; interestExpense?: YNum; netIncome?: YNum;
  endDate?: YNum;
}

function parseFundamentals(symbol: string, r: Record<string, unknown>): Fundamentals | null {
  const price = (r.price ?? {}) as PriceModule;
  const sd = (r.summaryDetail ?? {}) as SummaryDetail;
  const ks = (r.defaultKeyStatistics ?? {}) as KeyStats;
  const fd = (r.financialData ?? {}) as FinancialData;
  const income = ((r.incomeStatementHistory ?? {}) as { incomeStatementHistory?: IncomeRow[] })
    .incomeStatementHistory;

  const src: Record<string, string> = {};
  const mark = (key: string, value: number | null, module: string) => {
    if (value !== null) src[key] = `yahoo:${module}`;
    return value;
  };

  const marketCap = mark("marketCap", num(sd.marketCap), "summaryDetail");
  const revenue = mark("revenueValue", num(fd.totalRevenue), "financialData");
  const grossProfits = num(fd.grossProfits);

  const latest = income && income.length > 0 ? income[0] : null;
  const ebit = mark("ebitValue", num(latest?.ebit), "incomeStatementHistory");
  const interestExpense = num(latest?.interestExpense);

  // 売上 3 年 CAGR。年次損益計算書が 4 期取れたときだけ計算する
  let revenue3yCagr: number | null = null;
  if (income && income.length >= 4) {
    const newest = num(income[0].totalRevenue);
    const oldest = num(income[3].totalRevenue);
    if (newest !== null && oldest !== null && oldest > 0 && newest > 0) {
      revenue3yCagr = (newest / oldest) ** (1 / 3) - 1;
      src.revenue3yCagr = "yahoo:incomeStatementHistory (4期からCAGR算出)";
    }
  }

  // 自己資本 = 時価総額 / PBR。決算書を1本増やさずに取れる恒等式。
  const pb = num(ks.priceToBook);
  const totalEquityValue =
    marketCap !== null && pb !== null && pb > 0 ? marketCap / pb : null;
  if (totalEquityValue !== null) src.totalEquityValue = "derived:時価総額/PBR";

  const base: Fundamentals = {
    symbol,
    asOf: new Date().toISOString(),
    source: "yahoo:quoteSummary",
    currency: fd.financialCurrency ?? price.currency ?? null,

    marketCap,
    enterpriseValue: mark("enterpriseValue", num(ks.enterpriseValue), "defaultKeyStatistics"),
    sharesOutstanding: mark("sharesOutstanding", num(ks.sharesOutstanding), "defaultKeyStatistics"),
    floatShares: mark("floatShares", num(ks.floatShares), "defaultKeyStatistics"),

    trailingPE: mark("trailingPE", num(sd.trailingPE), "summaryDetail"),
    forwardPE: mark("forwardPE", num(sd.forwardPE) ?? num(ks.forwardPE), "summaryDetail"),
    pegRatio: mark("pegRatio", num(ks.pegRatio), "defaultKeyStatistics"),
    priceToBook: mark("priceToBook", pb, "defaultKeyStatistics"),
    priceToSales: mark("priceToSales", num(sd.priceToSalesTrailing12Months), "summaryDetail"),
    evToEbitda: mark("evToEbitda", num(ks.enterpriseToEbitda), "defaultKeyStatistics"),
    evToSales: mark("evToSales", num(ks.enterpriseToRevenue), "defaultKeyStatistics"),
    evToFcf: null,
    earningsYield: null,
    fcfYield: null,
    dividendYield: mark("dividendYield", normalizeYield(num(sd.dividendYield)), "summaryDetail"),
    payoutRatio: mark("payoutRatio", num(sd.payoutRatio), "summaryDetail"),
    buybackYield: null,

    returnOnEquity: mark("returnOnEquity", num(fd.returnOnEquity), "financialData"),
    returnOnAssets: mark("returnOnAssets", num(fd.returnOnAssets), "financialData"),
    returnOnInvestedCapital: null,
    grossMargin: mark(
      "grossMargin",
      num(fd.grossMargins) ?? (grossProfits !== null && revenue ? grossProfits / revenue : null),
      "financialData"
    ),
    operatingMargin: mark("operatingMargin", num(fd.operatingMargins), "financialData"),
    profitMargin: mark("profitMargin", num(fd.profitMargins) ?? num(ks.profitMargins), "financialData"),
    ebitdaMargin: mark("ebitdaMargin", num(fd.ebitdaMargins), "financialData"),

    debtToEquity: mark("debtToEquity", num(fd.debtToEquity), "financialData"),
    netDebtToEbitda: null,
    currentRatio: mark("currentRatio", num(fd.currentRatio), "financialData"),
    quickRatio: mark("quickRatio", num(fd.quickRatio), "financialData"),
    interestCoverage: null,
    totalCash: mark("totalCash", num(fd.totalCash), "financialData"),
    totalDebt: mark("totalDebt", num(fd.totalDebt), "financialData"),

    revenueGrowth: mark("revenueGrowth", num(fd.revenueGrowth), "financialData"),
    earningsGrowth: mark("earningsGrowth", num(fd.earningsGrowth), "financialData"),
    earningsQuarterlyGrowth: mark(
      "earningsQuarterlyGrowth",
      num(ks.earningsQuarterlyGrowth),
      "defaultKeyStatistics"
    ),
    revenue3yCagr,

    beta: mark("beta", num(sd.beta) ?? num(ks.beta), "summaryDetail"),
    shortPercentOfFloat: mark("shortPercentOfFloat", num(ks.shortPercentOfFloat), "defaultKeyStatistics"),
    heldPercentInstitutions: mark("heldPercentInstitutions", num(ks.heldPercentInstitutions), "defaultKeyStatistics"),
    heldPercentInsiders: mark("heldPercentInsiders", num(ks.heldPercentInsiders), "defaultKeyStatistics"),

    trailingEps: mark("trailingEps", num(ks.trailingEps), "defaultKeyStatistics"),
    forwardEps: mark("forwardEps", num(ks.forwardEps), "defaultKeyStatistics"),
    bookValuePerShare: mark("bookValuePerShare", num(ks.bookValue), "defaultKeyStatistics"),
    revenuePerShare: mark("revenuePerShare", num(fd.revenuePerShare), "financialData"),

    revenueValue: revenue,
    ebitdaValue: mark("ebitdaValue", num(fd.ebitda), "financialData"),
    ebitValue: ebit,
    freeCashflowValue: mark("freeCashflowValue", num(fd.freeCashflow), "financialData"),
    operatingCashflowValue: mark("operatingCashflowValue", num(fd.operatingCashflow), "financialData"),
    totalEquityValue,
    interestExpenseValue: interestExpense,

    fieldSources: src,
  };

  // 何一つ取れていないなら「ファンダは無い」と返す。空オブジェクトを
  // 返すとスクリーナー側で「全項目最下位の銘柄」として並んでしまう。
  const hasAny = [
    base.trailingPE, base.forwardPE, base.priceToBook, base.marketCap,
    base.returnOnEquity, base.revenueValue,
  ].some((x) => x !== null);
  if (!hasAny) return null;

  return deriveFundamentals(base);
}

/** Yahoo の配当利回りは % で来る場合と小数で来る場合がある。小数に揃える */
function normalizeYield(x: number | null): number | null {
  if (x === null) return null;
  // 0.5 = 50% はあり得るが 0.5%(=0.005) との区別が付かない。
  // 実務上、配当利回り 1 (=100%) を超えることはまず無いので
  // 1 を超えたら「%表記で来た」と判断して 100 で割る。
  return x > 1 ? x / 100 : x;
}

interface RecTrendRow {
  period?: string; strongBuy?: number; buy?: number; hold?: number;
  sell?: number; strongSell?: number;
}
interface EarningsTrendRow {
  period?: string;
  epsRevisions?: {
    upLast7days?: YNum; upLast30days?: YNum; downLast30days?: YNum; downLast7days?: YNum;
  };
}

/** レーティング分布を 1 本のスコアに畳む。+2 = 全員 Strong Buy */
function ratingScore(row: RecTrendRow): number | null {
  const sb = row.strongBuy ?? 0;
  const b = row.buy ?? 0;
  const h = row.hold ?? 0;
  const s = row.sell ?? 0;
  const ss = row.strongSell ?? 0;
  const n = sb + b + h + s + ss;
  if (n === 0) return null;
  return (sb * 2 + b * 1 + h * 0 + s * -1 + ss * -2) / n;
}

function parseConsensus(symbol: string, r: Record<string, unknown>): Consensus | null {
  const fd = (r.financialData ?? {}) as FinancialData;
  const rt = ((r.recommendationTrend ?? {}) as { trend?: RecTrendRow[] }).trend ?? [];
  const et = ((r.earningsTrend ?? {}) as { trend?: EarningsTrendRow[] }).trend ?? [];

  const targetMean = num(fd.targetMeanPrice);
  const targetHigh = num(fd.targetHighPrice);
  const targetLow = num(fd.targetLowPrice);
  const current = num(fd.currentPrice);
  const recMean = num(fd.recommendationMean);
  const analystCount = num(fd.numberOfAnalystOpinions);

  const trend = rt
    .filter((x) => typeof x.period === "string")
    .map((x) => ({
      period: x.period!,
      strongBuy: x.strongBuy ?? 0,
      buy: x.buy ?? 0,
      hold: x.hold ?? 0,
      sell: x.sell ?? 0,
      strongSell: x.strongSell ?? 0,
    }));

  // Yahoo の period は "0m"(今月) / "-1m" / "-2m" / "-3m"
  const now = trend.find((t) => t.period === "0m");
  const past = trend.find((t) => t.period === "-3m") ?? trend.find((t) => t.period === "-2m");
  const sNow = now ? ratingScore(now) : null;
  const sPast = past ? ratingScore(past) : null;
  const ratingMomentum = sNow !== null && sPast !== null ? sNow - sPast : null;

  const rev = et.find((x) => x.period === "0q") ?? et[0];
  const epsRevision = rev?.epsRevisions
    ? {
        period: rev.period ?? "0q",
        up: num(rev.epsRevisions.upLast30days) ?? 0,
        down: num(rev.epsRevisions.downLast30days) ?? 0,
      }
    : null;

  if (targetMean === null && recMean === null && trend.length === 0) return null;

  return {
    symbol,
    asOf: new Date().toISOString(),
    source: "yahoo:quoteSummary",
    recommendationMean: recMean,
    recommendationKey: fd.recommendationKey ?? null,
    analystCount: analystCount === null ? null : Math.round(analystCount),
    targetMean,
    targetHigh,
    targetLow,
    targetMedian: num(fd.targetMedianPrice),
    upsideToTarget:
      targetMean !== null && current !== null && current > 0 ? targetMean / current - 1 : null,
    targetDispersion:
      targetHigh !== null && targetLow !== null && targetMean !== null && targetMean > 0
        ? (targetHigh - targetLow) / targetMean
        : null,
    trend,
    ratingMomentum,
    epsRevision,
  };
}
