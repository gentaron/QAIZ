import {
  DEFAULT_FETCH_BUDGET,
  DEFAULT_SHARDS,
  REGION_META,
  SECTOR_META,
  UNIVERSE,
  VERSION,
  getInstrument,
  sectorCells,
  shardUniverse,
} from "./config/index.ts";
import { aiSentiment, matchHeadlines } from "./ai/sentiment.ts";
import { generateNewsBrief, ruleBasedBrief } from "./ai/brief.ts";
import type { BriefContext } from "./ai/brief.ts";
import { FetchBudget, mapWithConcurrency } from "./datasources/http.ts";
import { fetchNews } from "./datasources/rss.ts";
import { fetchStooqDaily } from "./datasources/stooq.ts";
import {
  createYahooSession,
  fetchYahooChart,
  fetchYahooQuoteSummary,
} from "./datasources/yahoo.ts";
import { buildSectorAggregates } from "./analytics/aggregate.ts";
import { computeBreadth } from "./analytics/breadth.ts";
import { correlationMatrix } from "./analytics/correlation.ts";
import {
  GROWTH_METRICS,
  QUALITY_METRICS,
  VALUATION_METRICS,
  buildScorecards,
} from "./analytics/fundamentals.ts";
import { computeFactors, parseWeights } from "./analytics/factors.ts";
import { buildOutlook } from "./analytics/outlook.ts";
import { computeRegime } from "./analytics/regime.ts";
import { computePriceSummary } from "./analytics/returns.ts";
import { computeRisk } from "./analytics/risk.ts";
import { rotationPoint } from "./analytics/rotation.ts";
import { generateSignals } from "./analytics/signals.ts";
import { computeTechnicals, sparkline } from "./analytics/technicals.ts";
import {
  loadAllSeries,
  loadRecords,
  loadSession,
  nextShard,
  saveMeta,
  saveOutlook,
  saveRecord,
  saveSeries,
  saveSession,
} from "./storage.ts";
import type {
  Breadth,
  Env,
  Instrument,
  InstrumentRecord,
  NewsBrief,
  NewsItem,
  RegionId,
  RotationPoint,
  SentimentResult,
  Series,
  Snapshot,
} from "./types.ts";

/**
 * 収集 → 分析 → 集計 → 保存のパイプライン。
 *
 * 全銘柄を毎回取りに行くことはできない (Workers 無料プランは 1 実行あたり
 * サブリクエスト 50 本、CPU も ms 単位で有限)。そこでユニバースをシャードに
 * 割り、cron が回るたびに 1 シャードずつ更新する。価格系列は DO に残るので、
 * 更新していない銘柄も相関・ローテーション・ランキングには参加できる。
 *
 * 副作用として「銘柄ごとに鮮度が違う」状態になるが、これは隠すべきでは
 * ないので record.asOf と dataQuality.lastBarDate をそのまま UI に出す。
 */

/** AI 呼び出し用に取り置く予算 (セクターセンチメント 6 + 概況要約 1) */
const AI_CALL_RESERVE = 7;
const SENTIMENT_MAX_CALLS = 6;

function envInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 例外を診断ラベルに落とす。
 *
 * meta.errors は認証なしの /api/meta から読めるので、例外オブジェクトを
 * そのまま文字列化して積んではいけない。取り出すのは種別とメッセージだけに
 * 限定し、スタックや内部パスが混ざる経路を作らない。
 * (`String(e)` は現状 name: message になるが、それに依存せず明示的に絞る。)
 */
function errorLabel(e: unknown, max = 80): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
  return raw.replace(/\s+/g, " ").slice(0, max);
}

/** ファンダメンタルズを取りに行く価値がある銘柄か */
function wantsFundamentals(inst: Instrument): boolean {
  // 指数・為替・商品・ETF には PER も ROE も無い。取りに行くだけ予算の無駄。
  return inst.assetClass === "equity";
}

async function fetchOne(
  inst: Instrument,
  budget: FetchBudget,
  errors: string[]
): Promise<Series | null> {
  if (!budget.take(`chart:${inst.symbol}`)) return null;
  try {
    const s = await fetchYahooChart(inst.symbol);
    if (s) return { ...s, currency: s.currency || inst.currency };
  } catch (e) {
    errors.push(`yahoo:${inst.symbol}:${errorLabel(e)}`);
  }
  if (inst.stooq && budget.take(`stooq:${inst.symbol}`)) {
    try {
      const s = await fetchStooqDaily(inst.stooq, inst.symbol, inst.currency);
      if (s) return s;
    } catch (e) {
      errors.push(`stooq:${inst.symbol}:${errorLabel(e)}`);
    }
  }
  errors.push(`no-price:${inst.symbol}`);
  return null;
}

/** 1 銘柄の分析 (価格系列だけから決まる部分) */
export function analyzeInstrument(
  inst: Instrument,
  series: Series,
  benchmark: Series | null
): InstrumentRecord {
  const bars = series.bars;
  const price = computePriceSummary(bars, series.currency || inst.currency);
  const technicals = computeTechnicals(bars);
  const useBenchmark =
    benchmark && benchmark.symbol !== inst.symbol ? benchmark : null;
  const risk = computeRisk(bars, useBenchmark?.bars ?? null, useBenchmark?.symbol ?? null);

  const warnings: string[] = [];
  if (bars.length < 252) warnings.push(`価格データが${bars.length}本のみ (1年未満の指標は算出不可)`);
  if (series.source === "stooq") warnings.push("Stooq由来: 配当調整なし。配当込みリターンとは差が出る");

  return {
    instrument: inst,
    asOf: new Date().toISOString(),
    price,
    technicals,
    risk,
    fundamentals: null,
    consensus: null,
    valuation: null,
    quality: null,
    growth: null,
    factors: null,
    signals: [],
    spark: sparkline(bars, 120),
    dataQuality: {
      bars: bars.length,
      priceSource: series.source,
      fundamentalsSource: null,
      lastBarDate: new Date(bars[bars.length - 1].t * 1000).toISOString().slice(0, 10),
      warnings,
    },
  };
}

/**
 * クロスセクションの後処理。
 *
 * スコアカードは **セクター単位** のピア群で作る (PER の水準はセクターで
 * まったく違うため)。ファクター合成はユニバース全体で行う — value/quality/
 * growth は既にセクター内相対に直っているので、そのまま横に並べてよい。
 */
export function applyCrossSection(
  records: Record<string, InstrumentRecord>,
  weightsJson: string | undefined
): void {
  const all = Object.values(records);
  const comparable = all.filter(
    (r) => r.instrument.role === "constituent" || r.instrument.role === "sector-proxy"
  );

  // --- セクター単位のスコアカード ---
  const bySector = new Map<string, InstrumentRecord[]>();
  for (const r of all) {
    if (!r.fundamentals) continue;
    const key = r.instrument.sector;
    const list = bySector.get(key) ?? [];
    list.push(r);
    bySector.set(key, list);
  }
  // ピアが少なすぎるセクターは全銘柄をピアにする。3 銘柄で Z を取ると
  // 「3 位だから最下位」という無意味なスコアになる。
  const globalPool = all.filter((r) => r.fundamentals);
  for (const [, list] of bySector) {
    const peers = list.length >= 6 ? list : globalPool;
    const inputs = peers.map((r) => ({
      symbol: r.instrument.symbol,
      fundamentals: r.fundamentals,
      consensus: r.consensus,
    }));
    const val = buildScorecards(inputs, VALUATION_METRICS);
    const qua = buildScorecards(inputs, QUALITY_METRICS);
    const gro = buildScorecards(inputs, GROWTH_METRICS);
    for (const r of list) {
      const s = r.instrument.symbol;
      r.valuation = val.get(s) ?? null;
      r.quality = qua.get(s) ?? null;
      r.growth = gro.get(s) ?? null;
    }
  }

  // --- ファクター合成 ---
  const factors = computeFactors(
    comparable.map((r) => ({
      symbol: r.instrument.symbol,
      price: r.price,
      risk: r.risk,
      valuation: r.valuation,
      quality: r.quality,
      growth: r.growth,
      technicalScore: r.technicals.compositeScore,
      above200dma: r.technicals.ma.above.sma200,
    })),
    parseWeights(weightsJson)
  );
  for (const r of comparable) r.factors = factors.get(r.instrument.symbol) ?? null;

  // --- シグナル (スコアカードが揃ってから) ---
  for (const r of all) {
    r.signals = generateSignals({
      price: r.price,
      technicals: r.technicals,
      risk: r.risk,
      fundamentals: r.fundamentals,
      consensus: r.consensus,
      valuation: r.valuation,
      quality: r.quality,
      growth: r.growth,
      factors: r.factors,
    });
  }
}

/**
 * セクターごとのニュースセンチメント (AI 呼び出し数を抑えるため上位のみ)。
 *
 * Workers AI の呼び出しもサブリクエストを 1 本消費する。予算を通さずに
 * 呼ぶと、価格取得と合わせて無料プランの上限 (50本/実行) を静かに超える。
 */
async function computeSentiment(
  env: Env,
  news: NewsItem[],
  budget: FetchBudget,
  maxCalls: number
): Promise<Map<string, SentimentResult>> {
  const out = new Map<string, SentimentResult>();
  const cells = sectorCells().filter((c) => c.region === "US" || c.region === "JP");
  let calls = 0;
  for (const cell of cells) {
    const meta = SECTOR_META[cell.sector];
    const headlines = matchHeadlines(news, meta.keywords);
    if (headlines.length === 0) continue;
    const key = `${cell.region}/${cell.sector}`;
    if (calls >= maxCalls) break;
    if (!budget.takeReserved(`ai-sentiment:${key}`)) break;
    out.set(key, await aiSentiment(env, meta.nameEn, headlines));
    calls++;
  }
  return out;
}

export interface PipelineOptions {
  /** 指定シャードだけを更新する (未指定ならカーソルを進める) */
  shard?: number;
  /** 全銘柄の分析を再計算する。CPU を食うので手動実行向け */
  recomputeAll?: boolean;
}

export async function runPipeline(
  env: Env,
  opts: PipelineOptions = {}
): Promise<Snapshot> {
  const started = Date.now();
  const errors: string[] = [];
  const shards = envInt(env.SHARDS, DEFAULT_SHARDS);
  // AI 呼び出し (セクターセンチメント最大 6 + 概況要約 1) の枠を先に取り置く。
  // 価格取得に先着で食われると、概況の要約が毎回出なくなる。
  const budget = new FetchBudget(
    envInt(env.FETCH_BUDGET, DEFAULT_FETCH_BUDGET),
    AI_CALL_RESERVE
  );

  const shard = opts.shard !== undefined ? opts.shard : await nextShard(env, shards);
  const targets = shardUniverse(shard, shards);

  /* ---------- 1. ニュース ---------- */
  const news = await fetchNews(budget).catch(() => [] as NewsItem[]);

  /* ---------- 2. Yahoo セッション (ファンダ取得用) ---------- */
  let session = await loadSession(env).catch(() => null);
  const needFundamentals = targets.some(wantsFundamentals);
  if (!session && needFundamentals && budget.take("yahoo-session", 2)) {
    session = await createYahooSession();
    if (session) await saveSession(env, session).catch(() => {});
    else errors.push("yahoo:crumb取得に失敗 — 今回はファンダメンタルズ無しで続行");
  }

  /* ---------- 3. 価格の取得 ---------- */
  const fetched = await mapWithConcurrency(targets, 4, (inst) =>
    fetchOne(inst, budget, errors)
  );
  const fetchedSeries = new Map<string, Series>();
  for (const s of fetched) if (s) fetchedSeries.set(s.symbol, s);
  await Promise.all([...fetchedSeries.values()].map((s) => saveSeries(env, s).catch(() => {})));

  /* ---------- 4. ファンダメンタルズ ---------- */
  const fundamentals = new Map<
    string,
    { fundamentals: NonNullable<InstrumentRecord["fundamentals"]> | null; consensus: InstrumentRecord["consensus"] }
  >();
  if (session) {
    const wants = targets.filter((i) => wantsFundamentals(i) && fetchedSeries.has(i.symbol));
    await mapWithConcurrency(wants, 3, async (inst) => {
      if (!budget.take(`fundamentals:${inst.symbol}`)) return;
      try {
        const qs = await fetchYahooQuoteSummary(inst.symbol, session!);
        if (qs) fundamentals.set(inst.symbol, qs);
        else errors.push(`fundamentals:${inst.symbol}:取得不可`);
      } catch (e) {
        errors.push(`fundamentals:${inst.symbol}:${errorLabel(e, 60)}`);
      }
    });
  }

  /* ---------- 5. 分析 ---------- */
  const cachedSeries = await loadAllSeries(env).catch(() => ({} as Record<string, Series>));
  const allSeries: Record<string, Series> = { ...cachedSeries };
  for (const [k, v] of fetchedSeries) allSeries[k] = v;

  const previous = await loadRecords(env).catch(() => ({} as Record<string, InstrumentRecord>));
  const records: Record<string, InstrumentRecord> = {};

  for (const inst of UNIVERSE) {
    const series = allSeries[inst.symbol];
    if (!series) continue;

    const benchSymbol = REGION_META[inst.region]?.benchmark ?? "^GSPC";
    const bench = allSeries[benchSymbol] ?? allSeries["^GSPC"] ?? null;

    // このシャードで取り直した銘柄だけ重い分析をやり直す。
    // 他は前回の結果を使い回す (日次バーなので 1 サイクル分の遅れは許容範囲)。
    const isFresh = fetchedSeries.has(inst.symbol);
    const prev = previous[inst.symbol];
    let rec: InstrumentRecord;
    if (isFresh || opts.recomputeAll || !prev) {
      rec = analyzeInstrument(inst, series, bench);
    } else {
      rec = { ...prev, instrument: inst };
    }

    const f = fundamentals.get(inst.symbol);
    if (f) {
      rec.fundamentals = f.fundamentals;
      rec.consensus = f.consensus;
      rec.dataQuality = {
        ...rec.dataQuality,
        fundamentalsSource: f.fundamentals?.source ?? null,
      };
    } else if (prev && !opts.recomputeAll) {
      // 今回取っていない銘柄は前回のファンダを引き継ぐ (四半期単位でしか
      // 動かない値なので、価格ほど鮮度は要らない)
      rec.fundamentals = rec.fundamentals ?? prev.fundamentals;
      rec.consensus = rec.consensus ?? prev.consensus;
      rec.dataQuality.fundamentalsSource =
        rec.dataQuality.fundamentalsSource ?? prev.dataQuality.fundamentalsSource;
    }
    records[inst.symbol] = rec;
  }

  applyCrossSection(records, env.FACTOR_WEIGHTS);

  /* ---------- 6. 集計 ---------- */
  const sentiment = await computeSentiment(env, news, budget, SENTIMENT_MAX_CALLS).catch(
    () => new Map<string, SentimentResult>()
  );
  const sectors = buildSectorAggregates(records, sentiment);

  /* ---------- 7. ローテーション ---------- */
  const rotation: RotationPoint[] = [];
  for (const inst of UNIVERSE) {
    if (inst.role !== "sector-proxy") continue;
    const s = allSeries[inst.symbol];
    const bench = allSeries[REGION_META[inst.region]?.benchmark ?? "^GSPC"];
    if (!s || !bench || bench.symbol === inst.symbol) continue;
    const p = rotationPoint(inst, s.bars, bench.bars);
    if (p) rotation.push(p);
  }

  /* ---------- 8. 市場の幅 ---------- */
  const list = Object.values(records);
  const breadth: Breadth[] = [];
  const globalBreadth = computeBreadth("グローバル", list);
  if (globalBreadth) breadth.push(globalBreadth);
  for (const region of ["US", "JP", "EU"] as RegionId[]) {
    const b = computeBreadth(
      REGION_META[region].nameJa,
      list.filter((r) => r.instrument.region === region)
    );
    if (b) breadth.push(b);
  }

  /* ---------- 9. レジーム ---------- */
  const regime = computeRegime(records, globalBreadth);

  /* ---------- 9-b. ニュース概況の要約 ---------- *
   * レジームと幅が出てからでないと「数字と突き合わせた要約」が書けないので、
   * センチメント判定より後ろに置いている。AI が使えなくても必ず値を返す。
   */
  const briefContext: BriefContext = { regime, breadth, sectors };
  let newsBrief: NewsBrief;
  if (budget.takeReserved("ai-brief")) {
    newsBrief = await generateNewsBrief(env, news, briefContext).catch((e) =>
      ruleBasedBrief(news, briefContext, `要約の生成に失敗: ${errorLabel(e, 40)}`)
    );
  } else {
    newsBrief = ruleBasedBrief(news, briefContext, "サブリクエスト予算切れで AI を呼べなかった");
  }

  /* ---------- 9-c. セクター見通し ---------- *
   * 外部フェッチも AI も使わない純粋な計算。予算切れでも必ず出る。
   */
  const outlook = buildOutlook({ sectors, records, rotation, regime, news });

  /* ---------- 10. 相関 ---------- */
  const corrSymbols = [
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLP", "XLU", "XLI", "XLB", "XLRE", "XLC",
    "SMH", "GLD", "TLT", "HYG", "BTC-USD", "^GSPC", "^N225", "^STOXX50E", "EEM",
  ];
  const corrInputs = corrSymbols
    .map((s) => ({ s, series: allSeries[s], inst: getInstrument(s) }))
    .filter((x) => x.series && x.inst)
    .map((x) => ({ symbol: x.s, label: x.inst!.nameJa, bars: x.series!.bars }));
  const correlation = correlationMatrix(corrInputs, 126);

  /* ---------- 11. 保存 ---------- */
  const covered = Object.keys(records).length;
  const meta: Omit<Snapshot, "records" | "outlook"> = {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    sectors,
    rotation,
    breadth,
    regime,
    correlation,
    news: news.slice(0, 60),
    newsBrief,
    meta: {
      universeSize: UNIVERSE.length,
      covered,
      shard,
      shards,
      fetches: budget.spent,
      aiModel: env.SENTIMENT_MODEL,
      dataSources: ["yahoo-finance", "stooq", "rss"],
      elapsedMs: Date.now() - started,
      errors: [...errors, ...budget.skipped.map((s) => `budget-skip:${s}`)].slice(0, 30),
    },
  };

  // 見通しは柱の内訳を持つぶん重い。meta と同じ値に入れると DO の
  // 1 値あたりの上限 (128 KiB) に当たるので、別キーに分けて保存する。
  await Promise.all([
    saveMeta(env, meta),
    saveOutlook(env, outlook),
    ...Object.values(records).map((r) => saveRecord(env, r).catch(() => {})),
  ]);

  return { ...meta, outlook, records };
}
