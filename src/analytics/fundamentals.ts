import type { Consensus, Fundamentals, MetricScore, Scorecard } from "../types.ts";
import { isNum, median, percentileRanks, round, zscores, zToScore } from "./stats.ts";

/**
 * ファンダメンタルズのスコアカード。
 *
 * 核心は「絶対値では評価しない」こと。PER 12 倍が割安かどうかは
 * 銀行かソフトウェアかで正反対になる。ここでは必ずピア群 (同一セクター)
 * の中での相対位置に変換してから合成する。
 *
 * もう一つの原則は「異常値を欠損として落とす」。赤字企業の PER は
 * 負になり、それを「超割安」と読むと必ず事故る。指標ごとに現実的な
 * 定義域を置き、外れたら null にしてカバレッジを下げる。
 */

export interface MetricDef {
  key: string;
  label: string;
  unit: MetricScore["unit"];
  lowerIsBetter: boolean;
  weight: number;
  /** 値の定義域。外れたら欠損として扱う */
  domain: [number, number];
  get: (f: Fundamentals, c: Consensus | null) => number | null;
}

const v = (x: number | null | undefined): number | null => (isNum(x) ? x : null);

export const VALUATION_METRICS: MetricDef[] = [
  { key: "trailingPE",   label: "PER (実績)",     unit: "x", lowerIsBetter: true,  weight: 1.2, domain: [0.5, 200],  get: (f) => v(f.trailingPE) },
  { key: "forwardPE",    label: "PER (予想)",     unit: "x", lowerIsBetter: true,  weight: 1.4, domain: [0.5, 200],  get: (f) => v(f.forwardPE) },
  { key: "priceToBook",  label: "PBR",            unit: "x", lowerIsBetter: true,  weight: 1.2, domain: [0.05, 60],  get: (f) => v(f.priceToBook) },
  { key: "priceToSales", label: "PSR",            unit: "x", lowerIsBetter: true,  weight: 0.8, domain: [0.02, 80],  get: (f) => v(f.priceToSales) },
  { key: "evToEbitda",   label: "EV/EBITDA",      unit: "x", lowerIsBetter: true,  weight: 1.2, domain: [0.5, 100],  get: (f) => v(f.evToEbitda) },
  { key: "pegRatio",     label: "PEG",            unit: "x", lowerIsBetter: true,  weight: 0.8, domain: [0.05, 12],  get: (f) => v(f.pegRatio) },
  { key: "fcfYield",     label: "FCF利回り",      unit: "%", lowerIsBetter: false, weight: 1.2, domain: [-0.3, 0.5], get: (f) => v(f.fcfYield) },
  { key: "earningsYield",label: "益利回り",       unit: "%", lowerIsBetter: false, weight: 1.0, domain: [-0.2, 0.5], get: (f) => v(f.earningsYield) },
  { key: "dividendYield",label: "配当利回り",     unit: "%", lowerIsBetter: false, weight: 0.7, domain: [0, 0.20],   get: (f) => v(f.dividendYield) },
];

export const QUALITY_METRICS: MetricDef[] = [
  { key: "returnOnEquity",   label: "ROE",           unit: "%",     lowerIsBetter: false, weight: 1.5, domain: [-1, 2],    get: (f) => v(f.returnOnEquity) },
  { key: "returnOnAssets",   label: "ROA",           unit: "%",     lowerIsBetter: false, weight: 1.0, domain: [-0.5, 0.6],get: (f) => v(f.returnOnAssets) },
  { key: "returnOnInvestedCapital", label: "ROIC",   unit: "%",     lowerIsBetter: false, weight: 1.2, domain: [-0.5, 1],  get: (f) => v(f.returnOnInvestedCapital) },
  { key: "grossMargin",      label: "粗利益率",      unit: "%",     lowerIsBetter: false, weight: 0.9, domain: [0, 1],     get: (f) => v(f.grossMargin) },
  { key: "operatingMargin",  label: "営業利益率",    unit: "%",     lowerIsBetter: false, weight: 1.2, domain: [-0.5, 0.8],get: (f) => v(f.operatingMargin) },
  { key: "profitMargin",     label: "純利益率",      unit: "%",     lowerIsBetter: false, weight: 1.0, domain: [-0.5, 0.8],get: (f) => v(f.profitMargin) },
  { key: "debtToEquity",     label: "D/Eレシオ",     unit: "ratio", lowerIsBetter: true,  weight: 1.0, domain: [0, 500],   get: (f) => v(f.debtToEquity) },
  { key: "netDebtToEbitda",  label: "ネット有利子負債/EBITDA", unit: "x", lowerIsBetter: true, weight: 0.9, domain: [-5, 12], get: (f) => v(f.netDebtToEbitda) },
  { key: "currentRatio",     label: "流動比率",      unit: "ratio", lowerIsBetter: false, weight: 0.6, domain: [0.1, 10],  get: (f) => v(f.currentRatio) },
  { key: "interestCoverage", label: "インタレストカバレッジ", unit: "x", lowerIsBetter: false, weight: 0.7, domain: [-10, 100], get: (f) => v(f.interestCoverage) },
];

export const GROWTH_METRICS: MetricDef[] = [
  { key: "revenueGrowth",           label: "売上成長率 (前年比)", unit: "%", lowerIsBetter: false, weight: 1.3, domain: [-0.8, 3], get: (f) => v(f.revenueGrowth) },
  { key: "earningsGrowth",          label: "利益成長率 (前年比)", unit: "%", lowerIsBetter: false, weight: 1.3, domain: [-2, 5],   get: (f) => v(f.earningsGrowth) },
  { key: "earningsQuarterlyGrowth", label: "四半期利益成長率",    unit: "%", lowerIsBetter: false, weight: 1.0, domain: [-2, 5],   get: (f) => v(f.earningsQuarterlyGrowth) },
  { key: "revenue3yCagr",           label: "売上3年CAGR",         unit: "%", lowerIsBetter: false, weight: 1.0, domain: [-0.5, 2], get: (f) => v(f.revenue3yCagr) },
  { key: "ratingMomentum",          label: "レーティング改定",    unit: "score", lowerIsBetter: false, weight: 0.8, domain: [-2, 2], get: (_f, c) => v(c?.ratingMomentum) },
];

export interface PeerInput {
  symbol: string;
  fundamentals: Fundamentals | null;
  consensus: Consensus | null;
}

/** 定義域でフィルタした生値を取り出す */
function rawValue(def: MetricDef, p: PeerInput): number | null {
  if (!p.fundamentals) return null;
  const x = def.get(p.fundamentals, p.consensus);
  if (!isNum(x)) return null;
  if (x < def.domain[0] || x > def.domain[1]) return null;
  return x;
}

/**
 * ピア群に対して 1 つのスコアカードを作る。
 *
 * 戻り値はピア群の全メンバー分。ある銘柄だけ計算し直す、という
 * 使い方はできない (相対評価なので当然だが、明示しておく)。
 */
export function buildScorecards(
  peers: PeerInput[],
  metrics: MetricDef[]
): Map<string, Scorecard> {
  const perMetric = metrics.map((def) => {
    const raw = peers.map((p) => rawValue(def, p));
    // 「小さいほど良い」指標は符号を反転してから Z を取る。
    // こうしておくと以降のレイヤーは「Z が高い = 良い」だけを見ればよい。
    const oriented = raw.map((x) => (x === null ? null : def.lowerIsBetter ? -x : x));
    const z = zscores(oriented, { winsorizeAt: 0.05, robust: true });
    const pct = percentileRanks(oriented);
    const med = median(raw.filter(isNum));
    return { def, raw, z, pct, med };
  });

  const out = new Map<string, Scorecard>();
  peers.forEach((p, i) => {
    const ms: MetricScore[] = [];
    let acc = 0;
    let wsum = 0;
    let available = 0;
    for (const m of perMetric) {
      const zi = m.z[i];
      ms.push({
        key: m.def.key,
        label: m.def.label,
        value: round(m.raw[i], 5),
        z: round(zi, 3),
        percentile: round(m.pct[i], 1),
        peerMedian: round(m.med, 5),
        lowerIsBetter: m.def.lowerIsBetter,
        unit: m.def.unit,
      });
      if (isNum(zi)) {
        acc += zi * m.def.weight;
        wsum += m.def.weight;
        available++;
      }
    }
    const coverage = metrics.length > 0 ? available / metrics.length : 0;
    // カバレッジが低すぎるスコアは出さない。1 指標だけで
    // 「バリュエーション 92 点」と表示するのは嘘に近い。
    const score = wsum > 0 && coverage >= 0.3 ? zToScore(acc / wsum) : null;
    out.set(p.symbol, { score, metrics: ms, coverage: round(coverage, 2)! });
  });
  return out;
}

/**
 * Yahoo 等から取れた素の値から派生指標を埋める。
 * 取れなかったものは null のまま。ここで推定値を入れると
 * 「実測」と「推定」が区別できなくなる。
 */
export function deriveFundamentals(f: Fundamentals): Fundamentals {
  const out = { ...f };
  const src = { ...f.fieldSources };
  const put = (key: keyof Fundamentals, value: number | null, how: string) => {
    if (value !== null && !isNum(out[key] as number | null)) {
      (out[key] as number | null) = value;
      src[key] = how;
    }
  };

  if (isNum(f.trailingPE) && f.trailingPE > 0) {
    put("earningsYield", 1 / f.trailingPE, "derived:1/PER");
  }
  if (isNum(f.freeCashflowValue) && isNum(f.marketCap) && f.marketCap > 0) {
    put("fcfYield", f.freeCashflowValue / f.marketCap, "derived:FCF/時価総額");
  }
  if (isNum(f.freeCashflowValue) && isNum(f.enterpriseValue) && f.freeCashflowValue > 0) {
    put("evToFcf", f.enterpriseValue / f.freeCashflowValue, "derived:EV/FCF");
  }
  if (isNum(f.ebitdaValue) && isNum(f.revenueValue) && f.revenueValue > 0) {
    put("ebitdaMargin", f.ebitdaValue / f.revenueValue, "derived:EBITDA/売上");
  }
  if (isNum(f.ebitdaValue) && f.ebitdaValue > 0 && isNum(f.totalDebt)) {
    const net = f.totalDebt - (isNum(f.totalCash) ? f.totalCash : 0);
    put("netDebtToEbitda", net / f.ebitdaValue, "derived:(有利子負債-現金)/EBITDA");
  }
  if (isNum(f.enterpriseValue) && isNum(f.revenueValue) && f.revenueValue > 0) {
    put("evToSales", f.enterpriseValue / f.revenueValue, "derived:EV/売上");
  }
  // ROIC ≒ NOPAT / (有利子負債 + 自己資本)。税率は開示が無いので 25% を仮定し、
  // その仮定を fieldSources に残す。仮定を隠した指標は使い物にならない。
  if (isNum(f.ebitValue) && isNum(f.totalDebt) && isNum(f.totalEquityValue)) {
    const capital = f.totalDebt + f.totalEquityValue;
    if (capital > 0) put("returnOnInvestedCapital", (f.ebitValue * 0.75) / capital, "derived:NOPAT/投下資本 (実効税率25%仮定)");
  }
  if (isNum(f.ebitValue) && isNum(f.interestExpenseValue) && f.interestExpenseValue > 0) {
    put("interestCoverage", f.ebitValue / f.interestExpenseValue, "derived:EBIT/支払利息");
  }
  out.fieldSources = src;
  return out;
}
