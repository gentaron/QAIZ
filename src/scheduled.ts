import { GLOBAL_INDICES, SECTORS, VERSION } from "./config.ts";
import { loadLedger, saveLedger, saveSnapshot } from "./storage.ts";
import { runBasketJob, runTailRiskJob, recordEntries } from "./os/kernel.ts";
import { basketReturns, covarianceMatrix } from "./problems/basket.ts";
import type { LedgerEntry } from "./os/ledger.ts";
import { aiSentiment } from "./ai/sentiment.ts";
import { fetchGdeltArticles } from "./datasources/gdelt.ts";
import { fetchAllNews } from "./datasources/rss.ts";
import { fetchStooqDaily } from "./datasources/stooq.ts";
import { fetchYahooDaily } from "./datasources/yahoo.ts";
import { computeCosmoSpectral } from "./engine/cosmology.ts";
import { computeMomentum, logReturns } from "./engine/momentum.ts";
import { computeQuantumGeometry } from "./engine/quantumGeometry.ts";
import { computeHeatScore } from "./engine/scoring.ts";
import type {
  Env,
  GlobalIndexQuote,
  LedgerEntrySummary,
  NewsItem,
  QuantumDecision,
  SectorDef,
  SectorScore,
  Series,
  Snapshot,
} from "./types.ts";

/** スコア済みセクターと、量子OSに渡すためのリターン系列 */
export interface ScoredSector {
  score: SectorScore;
  returns: number[];
}

/** 並列数を抑えた Promise 実行 (外部APIへの礼儀 + Workers サブリクエスト制限対策) */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

async function fetchSeriesWithFallback(
  sector: SectorDef,
  errors: string[]
): Promise<Series | null> {
  try {
    const s = await fetchYahooDaily(sector.symbol);
    if (s) return s;
  } catch (e) {
    errors.push(`yahoo:${sector.symbol}:${String(e)}`);
  }
  if (sector.stooqSymbol) {
    try {
      const s = await fetchStooqDaily(sector.stooqSymbol, sector.symbol);
      if (s) return s;
    } catch (e) {
      errors.push(`stooq:${sector.stooqSymbol}:${String(e)}`);
    }
  }
  errors.push(`no-data:${sector.symbol}`);
  return null;
}

function sectorHeadlines(
  sector: SectorDef,
  generalNews: NewsItem[],
  gdeltNews: NewsItem[]
): string[] {
  const kw = sector.keywords.map((k) => k.toLowerCase());
  const matched = generalNews
    .filter((n) => kw.some((k) => n.title.toLowerCase().includes(k)))
    .map((n) => n.title);
  return [...new Set([...matched, ...gdeltNews.map((n) => n.title)])];
}

async function scoreSector(
  env: Env,
  sector: SectorDef,
  generalNews: NewsItem[],
  errors: string[]
): Promise<ScoredSector | null> {
  const series = await fetchSeriesWithFallback(sector, errors);
  if (!series) return null;

  const returns = logReturns(series.bars);
  const momentum = computeMomentum(series.bars);
  const quantum = computeQuantumGeometry(returns);
  const cosmo = computeCosmoSpectral(returns);

  // 「人の言葉」レイヤー: RSS + GDELT からセクター関連ヘッドラインを収集
  const gdeltNews = await fetchGdeltArticles(sector.keywords, 6);
  const headlines = sectorHeadlines(sector, generalNews, gdeltNews);
  const sentiment =
    headlines.length > 0
      ? await aiSentiment(env, sector.nameEn, headlines)
      : null;

  const heat = computeHeatScore(momentum, quantum, cosmo, sentiment);

  const closes = series.bars.slice(-60).map((b) => b.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const spark = closes.map((c) =>
    max > min ? Math.round(((c - min) / (max - min)) * 1000) / 1000 : 0.5
  );

  return {
    score: {
      sector,
      momentum,
      quantum,
      cosmo,
      sentiment,
      heat,
      lastClose: series.bars[series.bars.length - 1].c,
      spark,
    },
    returns,
  };
}

async function fetchIndexQuote(idx: {
  symbol: string;
  name: string;
  region: string;
}): Promise<GlobalIndexQuote | null> {
  try {
    const s = await fetchYahooDaily(idx.symbol, "3mo");
    if (!s) return null;
    const bars = s.bars;
    const last = bars[bars.length - 1].c;
    const ret = (days: number) =>
      bars.length > days && bars[bars.length - 1 - days].c > 0
        ? last / bars[bars.length - 1 - days].c - 1
        : 0;
    return {
      symbol: idx.symbol,
      name: idx.name,
      region: idx.region,
      lastClose: last,
      r1d: ret(1),
      r1w: ret(5),
      r1m: ret(21),
    };
  } catch {
    return null;
  }
}

function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 量子OSを起動して「今週どのセクターを何本持つか」と「その尾リスク」を決める。
 *
 * ここが v0.1 との決定的な違い。従来はヒートスコアを並べて終わりだったので、
 * 計算量的に難しい問題がどこにも存在せず、量子を挿す場所が原理的に無かった。
 * 基数制約付き選択 (NP困難) と確率推定 (振幅推定の対象) を通したことで、
 * はじめて「量子バックエンドを差し込める配管」と「その効果を測る尺度」が生まれる。
 */
export function runQuantumOs(
  scored: ScoredSector[],
  env: Pick<Env, "QUANTUM_BUDGET_MS" | "BASKET_CARDINALITY" | "TAIL_EPSILON">,
  errors: string[]
): { decision: QuantumDecision | null; entries: LedgerEntry[] } {
  const budgetMs = envNumber(env.QUANTUM_BUDGET_MS, 120);
  const cardinality = Math.round(envNumber(env.BASKET_CARDINALITY, 5));
  const epsilon = envNumber(env.TAIL_EPSILON, 0.01);

  // 共分散を作るには系列長が揃っている必要がある。直近 120 営業日で切り揃える。
  const window = 120;
  const usable = scored.filter((s) => s.returns.length >= window);
  if (usable.length < cardinality + 1) {
    errors.push(`quantum-os:insufficient-data:${usable.length}`);
    return { decision: null, entries: [] };
  }

  const ids = usable.map((s) => s.score.sector.id);
  const returns = usable.map((s) => s.returns.slice(-window));
  const mu = Float64Array.from(usable.map((s) => s.score.heat / 100));
  const sigma = covarianceMatrix(returns);

  // リスク回避係数: μ が [0,1]、日次分散が 1e-4 オーダーなので、
  // 両者が同じ桁で効くように正規化する (でないと片方が完全に無視される)。
  const meanVar =
    Array.from({ length: ids.length }, (_, i) => sigma[i * ids.length + i]).reduce(
      (a, b) => a + b,
      0
    ) / ids.length;
  const riskAversion = meanVar > 0 ? 0.5 / meanVar : 1;

  try {
    const basketJob = runBasketJob(
      { ids, mu, sigma, cardinality, riskAversion },
      { budgetMs: budgetMs * 0.7, seed: 20260805 }
    );

    const br = basketReturns(returns, basketJob.solution.mask);
    const riskJob = runTailRiskJob(
      { returns: br, epsilon, bins: 32, confidence: 0.95 },
      { budgetMs: budgetMs * 0.3, seed: 20260805 }
    );

    const entries = [basketJob.entry, riskJob.entry];
    const decision: QuantumDecision = {
      basket: {
        ids: basketJob.solution.selected,
        cardinality,
        riskAversion,
        expectedReturn: basketJob.solution.expectedReturn,
        variance: basketJob.solution.variance,
        objective: basketJob.solution.objective,
        feasible: basketJob.solution.feasible,
        matchesExact: basketJob.exact
          ? basketJob.exact.mask === basketJob.solution.mask
          : null,
      },
      risk: {
        varThreshold: riskJob.risk.varThreshold,
        cvar: riskJob.risk.cvar,
        tailProbability: riskJob.risk.exactTailProbability,
        quantumEstimate: riskJob.risk.quantum.estimate,
        epsilon: riskJob.risk.epsilon,
        oracleCalls: riskJob.risk.quantum.oracleCalls,
        classicalSamples: riskJob.risk.classical.requiredSamples,
        queryAdvantage: riskJob.risk.queryAdvantage,
        qubits: riskJob.risk.qubits,
      },
      ledgerEntries: entries.map(summarizeEntry),
      exactEnumerationWallAt: basketJob.exactWallAt,
      budgetMs,
    };
    return { decision, entries };
  } catch (e) {
    errors.push(`quantum-os:${String(e)}`);
    return { decision: null, entries: [] };
  }
}

function summarizeEntry(e: LedgerEntry): LedgerEntrySummary {
  return {
    ts: e.ts,
    problem: e.problem,
    size: e.size,
    verdict: e.verdict,
    summary: e.summary,
    runs: e.runs.map((r) => ({
      backend: r.backend,
      kind: r.kind,
      wallMs: Math.round(r.wallMs * 10) / 10,
      queries: r.queries,
      ok: r.ok,
      error: r.error,
    })),
    approximationRatio: e.quality?.approximationRatio,
  };
}

/** パイプライン本体: 収集 → 数理エンジン → AI → 量子OS → 永続化 */
export async function runPipeline(env: Env): Promise<Snapshot> {
  const errors: string[] = [];

  // 世界ニュース (RSS) は全セクター共通で1回だけ取得
  const generalNews = await fetchAllNews(10);

  const [sectorResults, indexResults] = await Promise.all([
    mapWithConcurrency(SECTORS, 4, (s) =>
      scoreSector(env, s, generalNews, errors)
    ),
    mapWithConcurrency(GLOBAL_INDICES, 4, fetchIndexQuote),
  ]);

  const scored = sectorResults.filter((s): s is ScoredSector => s !== null);
  const sectors = scored
    .map((s) => s.score)
    .sort((a, b) => b.heat - a.heat);
  const indices = indexResults.filter(
    (i): i is GlobalIndexQuote => i !== null
  );

  const { decision, entries } = runQuantumOs(scored, env, errors);

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    sectors,
    indices,
    news: generalNews.slice(0, 40),
    quantum: decision,
    meta: {
      version: VERSION,
      dataSources: ["yahoo-finance", "stooq", "rss", "gdelt"],
      aiModel: env.SENTIMENT_MODEL,
      errors: errors.slice(0, 20),
    },
  };

  await saveSnapshot(env, snapshot);
  if (entries.length > 0) {
    const ledger = await loadLedger(env).catch(() => null);
    await saveLedger(env, recordEntries(ledger, entries)).catch(() => {});
  }
  return snapshot;
}
