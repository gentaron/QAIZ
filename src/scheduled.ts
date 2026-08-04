import { GLOBAL_INDICES, SECTORS, VERSION } from "./config";
import { saveSnapshot } from "./storage";
import { aiSentiment } from "./ai/sentiment";
import { fetchGdeltArticles } from "./datasources/gdelt";
import { fetchAllNews } from "./datasources/rss";
import { fetchStooqDaily } from "./datasources/stooq";
import { fetchYahooDaily } from "./datasources/yahoo";
import { computeCosmoSpectral } from "./engine/cosmology";
import { computeMomentum, logReturns } from "./engine/momentum";
import { computeQuantumGeometry } from "./engine/quantumGeometry";
import { computeHeatScore } from "./engine/scoring";
import type {
  Env,
  GlobalIndexQuote,
  NewsItem,
  SectorDef,
  SectorScore,
  Series,
  Snapshot,
} from "./types";

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
): Promise<SectorScore | null> {
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
    sector,
    momentum,
    quantum,
    cosmo,
    sentiment,
    heat,
    lastClose: series.bars[series.bars.length - 1].c,
    spark,
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

/** パイプライン本体: 収集 → 数理エンジン → AI → KV 保存 */
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

  const sectors = sectorResults
    .filter((s): s is SectorScore => s !== null)
    .sort((a, b) => b.heat - a.heat);
  const indices = indexResults.filter(
    (i): i is GlobalIndexQuote => i !== null
  );

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    sectors,
    indices,
    news: generalNews.slice(0, 40),
    meta: {
      version: VERSION,
      dataSources: ["yahoo-finance", "stooq", "rss", "gdelt"],
      aiModel: env.SENTIMENT_MODEL,
      errors: errors.slice(0, 20),
    },
  };

  await saveSnapshot(env, snapshot);
  return snapshot;
}
