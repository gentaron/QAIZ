import type { InstrumentRecord, RegionId, SectorId } from "../types.ts";
import { isNum } from "./stats.ts";

/**
 * スクリーナー。
 *
 * レコードの任意のフィールドをドットパスで指定してフィルタ・ソートできる。
 * 「PBR 1倍割れ かつ ROE 10%以上 かつ 200日線の上」のような条件は、
 * 個別に UI を作るのではなく 1 本のクエリで表現できるべき。
 *
 * 欠損の扱いは 1 箇所に集約している: **欠損はどの比較にも一致しない**。
 * 「PER < 15」に PER 不明の銘柄が混ざるのが、スクリーニング事故の
 * いちばん多い原因なので、ここは例外なく落とす。
 */

export type Operator =
  | "gt" | "gte" | "lt" | "lte" | "eq" | "ne"
  | "between" | "exists" | "missing" | "in";

export interface Filter {
  field: string;
  op: Operator;
  value?: number | string | boolean | (string | number)[];
  value2?: number;
}

export interface ScreenerQuery {
  regions?: RegionId[];
  sectors?: SectorId[];
  roles?: string[];
  symbols?: string[];
  filters?: Filter[];
  sort?: { field: string; dir?: "asc" | "desc" }[];
  limit?: number;
  offset?: number;
  /** 返すフィールドを絞る (ドットパス)。未指定なら要約セット */
  fields?: string[];
}

/** ドットパスで値を取り出す */
export function pluck(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? null : cur;
}

function compare(actual: unknown, f: Filter): boolean {
  if (f.op === "exists") return actual !== null && actual !== undefined;
  if (f.op === "missing") return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;

  if (f.op === "in") {
    const list = Array.isArray(f.value) ? f.value : [];
    return list.some((v) => v === actual);
  }
  if (typeof actual === "boolean" || typeof f.value === "boolean") {
    if (f.op === "eq") return actual === f.value;
    if (f.op === "ne") return actual !== f.value;
    return false;
  }
  if (typeof actual === "string") {
    const v = String(f.value ?? "");
    if (f.op === "eq") return actual === v;
    if (f.op === "ne") return actual !== v;
    return false;
  }
  if (!isNum(actual)) return false;
  const a = actual;
  const v = typeof f.value === "number" ? f.value : Number(f.value);
  if (!Number.isFinite(v) && f.op !== "between") return false;

  switch (f.op) {
    case "gt": return a > v;
    case "gte": return a >= v;
    case "lt": return a < v;
    case "lte": return a <= v;
    case "eq": return a === v;
    case "ne": return a !== v;
    case "between": {
      const hi = typeof f.value2 === "number" ? f.value2 : Infinity;
      return a >= v && a <= hi;
    }
    default: return false;
  }
}

/** 要約プロジェクション: 表に出す標準列 */
export const SUMMARY_FIELDS = [
  "instrument.symbol",
  "instrument.nameJa",
  "instrument.name",
  "instrument.region",
  "instrument.sector",
  "instrument.role",
  "asOf",
  "price.last",
  "price.currency",
  "price.r1d",
  "price.r1w",
  "price.r1m",
  "price.r3m",
  "price.r12m",
  "price.ytd",
  "price.rangePosition52w",
  "price.drawdownFrom52wHigh",
  "price.volumeRatio",
  "technicals.rsi14",
  "technicals.compositeScore",
  "technicals.compositeLabel",
  "technicals.adx.adx",
  "technicals.ma.cross",
  "technicals.ma.above.sma200",
  "technicals.atrPercent",
  "risk.vol252",
  "risk.beta",
  "risk.maxDrawdown",
  "risk.sharpe",
  "risk.var95",
  "fundamentals.trailingPE",
  "fundamentals.forwardPE",
  "fundamentals.priceToBook",
  "fundamentals.priceToSales",
  "fundamentals.evToEbitda",
  "fundamentals.dividendYield",
  "fundamentals.returnOnEquity",
  "fundamentals.operatingMargin",
  "fundamentals.revenueGrowth",
  "fundamentals.earningsGrowth",
  "fundamentals.debtToEquity",
  "fundamentals.marketCap",
  "consensus.recommendationMean",
  "consensus.analystCount",
  "consensus.targetMean",
  "consensus.upsideToTarget",
  "valuation.score",
  "quality.score",
  "growth.score",
  "factors.composite",
  "factors.value",
  "factors.quality",
  "factors.momentum",
  "factors.growth",
  "factors.lowVol",
  "factors.rank",
];

function project(rec: InstrumentRecord, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = pluck(rec, f);
  return out;
}

export interface ScreenerResult {
  total: number;
  returned: number;
  fields: string[];
  rows: Record<string, unknown>[];
  /** 適用されたクエリ (デバッグと再現のためそのまま返す) */
  query: ScreenerQuery;
}

export function runScreener(
  records: InstrumentRecord[],
  query: ScreenerQuery
): ScreenerResult {
  let rows = records;

  if (query.symbols?.length) {
    const set = new Set(query.symbols);
    rows = rows.filter((r) => set.has(r.instrument.symbol));
  }
  if (query.regions?.length) {
    const set = new Set<string>(query.regions);
    rows = rows.filter((r) => set.has(r.instrument.region));
  }
  if (query.sectors?.length) {
    const set = new Set<string>(query.sectors);
    rows = rows.filter((r) => set.has(r.instrument.sector));
  }
  if (query.roles?.length) {
    const set = new Set(query.roles);
    rows = rows.filter((r) => set.has(r.instrument.role));
  }
  for (const f of query.filters ?? []) {
    rows = rows.filter((r) => compare(pluck(r, f.field), f));
  }

  const total = rows.length;

  const sorts = query.sort?.length
    ? query.sort
    : [{ field: "factors.composite", dir: "desc" as const }];
  rows = [...rows].sort((a, b) => {
    for (const s of sorts) {
      const av = pluck(a, s.field);
      const bv = pluck(b, s.field);
      const an = isNum(av) ? av : null;
      const bn = isNum(bv) ? bv : null;
      // 欠損は常に末尾。並べ替えの向きに関わらず「不明が上位」は避ける
      if (an === null && bn === null) continue;
      if (an === null) return 1;
      if (bn === null) return -1;
      if (an !== bn) return (s.dir ?? "desc") === "asc" ? an - bn : bn - an;
    }
    return a.instrument.symbol.localeCompare(b.instrument.symbol);
  });

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(500, Math.max(1, query.limit ?? 100));
  const page = rows.slice(offset, offset + limit);
  const fields = query.fields?.length ? query.fields : SUMMARY_FIELDS;

  return {
    total,
    returned: page.length,
    fields,
    rows: page.map((r) => project(r, fields)),
    query,
  };
}

/* ------------------------------------------------------------------ */
/* プリセット                                                          */
/* ------------------------------------------------------------------ */

export interface Preset {
  id: string;
  nameJa: string;
  description: string;
  query: ScreenerQuery;
}

export const PRESETS: Preset[] = [
  {
    id: "deep-value",
    nameJa: "ディープバリュー",
    description:
      "PBR 1.5倍以下 × 予想PER 15倍以下 × 営業黒字。安いだけの銘柄を除くため利益率で足切りしている。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "fundamentals.priceToBook", op: "lte", value: 1.5 },
        { field: "fundamentals.forwardPE", op: "between", value: 0, value2: 15 },
        { field: "fundamentals.operatingMargin", op: "gt", value: 0 },
      ],
      sort: [{ field: "factors.value", dir: "desc" }],
    },
  },
  {
    id: "quality-momentum",
    nameJa: "クオリティ × モメンタム",
    description:
      "ROE 15%以上 × 200日線の上 × 12-1モメンタム上位。実証的に最も頑健とされる組み合わせ。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "fundamentals.returnOnEquity", op: "gte", value: 0.15 },
        { field: "technicals.ma.above.sma200", op: "eq", value: true },
        { field: "price.r12m1m", op: "gt", value: 0 },
      ],
      sort: [{ field: "factors.momentum", dir: "desc" }],
    },
  },
  {
    id: "dividend-safety",
    nameJa: "高配当 × 配当余力",
    description:
      "配当利回り 3%以上 × 配当性向 70%以下 × D/E 150%以下。利回りだけで拾うと減配銘柄を掴むため、原資と財務で絞る。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "fundamentals.dividendYield", op: "gte", value: 0.03 },
        { field: "fundamentals.payoutRatio", op: "between", value: 0, value2: 0.7 },
        { field: "fundamentals.debtToEquity", op: "lte", value: 150 },
      ],
      sort: [{ field: "fundamentals.dividendYield", dir: "desc" }],
    },
  },
  {
    id: "oversold-quality",
    nameJa: "押し目のクオリティ株",
    description:
      "RSI 40以下 × 200日線の上 × ROE 12%以上。トレンドは生きているが短期的に売られた銘柄。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "technicals.rsi14", op: "lte", value: 40 },
        { field: "technicals.ma.above.sma200", op: "eq", value: true },
        { field: "fundamentals.returnOnEquity", op: "gte", value: 0.12 },
      ],
      sort: [{ field: "technicals.rsi14", dir: "asc" }],
    },
  },
  {
    id: "breakout",
    nameJa: "ブレイクアウト候補",
    description:
      "52週レンジ上位10% × ADX 25以上 × 出来高が20日平均超。トレンドが出ていて需給が伴っている銘柄。",
    query: {
      filters: [
        { field: "price.rangePosition52w", op: "gte", value: 0.9 },
        { field: "technicals.adx.adx", op: "gte", value: 25 },
        { field: "price.volumeRatio", op: "gte", value: 1 },
      ],
      sort: [{ field: "technicals.compositeScore", dir: "desc" }],
    },
  },
  {
    id: "growth-at-reasonable-price",
    nameJa: "GARP (成長 × 妥当価格)",
    description: "売上成長 10%以上 × PEG 2倍以下 × 営業利益率 10%以上。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "fundamentals.revenueGrowth", op: "gte", value: 0.1 },
        { field: "fundamentals.pegRatio", op: "between", value: 0, value2: 2 },
        { field: "fundamentals.operatingMargin", op: "gte", value: 0.1 },
      ],
      sort: [{ field: "factors.growth", dir: "desc" }],
    },
  },
  {
    id: "analyst-upside",
    nameJa: "アナリスト目標乖離",
    description: "アナリスト5名以上 × 目標株価まで20%以上 × レーティング強気化。",
    query: {
      roles: ["constituent"],
      filters: [
        { field: "consensus.analystCount", op: "gte", value: 5 },
        { field: "consensus.upsideToTarget", op: "gte", value: 0.2 },
        { field: "consensus.ratingMomentum", op: "gte", value: 0 },
      ],
      sort: [{ field: "consensus.upsideToTarget", dir: "desc" }],
    },
  },
  {
    id: "low-vol-defensive",
    nameJa: "低ボラ・ディフェンシブ",
    description: "年率ボラ 25%以下 × 最大DD -30%以内 × β 1.0以下。守りに寄せたい局面向け。",
    query: {
      filters: [
        { field: "risk.vol252", op: "lte", value: 0.25 },
        { field: "risk.maxDrawdown", op: "gte", value: -0.3 },
        { field: "risk.beta", op: "lte", value: 1.0 },
      ],
      sort: [{ field: "factors.lowVol", dir: "desc" }],
    },
  },
];
