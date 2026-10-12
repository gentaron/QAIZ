import {
  REGION_META,
  SECTOR_META,
  SECTOR_ORDER,
  UNIVERSE,
  VERSION,
  getInstrument,
} from "./config/index.ts";
import { runPipeline } from "./pipeline.ts";
import {
  AnalyticsStore,
  loadMeta,
  loadOutlook,
  loadRecords,
  loadSeries,
} from "./storage.ts";
import { loadPitRecords, pitStatus, toNdjson } from "./pit.ts";
import { PRESETS, SUMMARY_FIELDS, runScreener } from "./analytics/screener.ts";
import type { Filter, Operator, ScreenerQuery } from "./analytics/screener.ts";
import type { Env, InstrumentRecord, RegionId, SectorId } from "./types.ts";

export { AnalyticsStore };

/**
 * QAIZ — Quantitative Analyst Intelligence Zone
 *
 * 地域 × セクターの株式を、バリュエーション (PER/PBR/EV-EBITDA)、
 * クオリティ (ROE/利益率/財務)、成長、テクニカル、リスク、アナリスト
 * コンセンサスの全レイヤーで横断的に見るためのエッジ API + ダッシュボード。
 *
 * ルーティング:
 *   GET  /api/health                ヘルスチェック
 *   GET  /api/overview              ダッシュボード初期表示に必要な一式
 *   GET  /api/universe              ユニバース定義 (地域/セクター/銘柄)
 *   GET  /api/sectors?region=US     地域×セクター集計
 *   GET  /api/screener?...          スクリーニング (GET 簡易版)
 *   POST /api/screener              スクリーニング (JSON クエリ全機能)
 *   GET  /api/presets               プリセット条件一覧
 *   GET  /api/symbol/{symbol}       個別銘柄の全分析
 *   GET  /api/compare?symbols=a,b   複数銘柄の横並び
 *   GET  /api/history/{symbol}      日次バー (チャート描画用)
 *   GET  /api/rotation?region=US    セクターローテーション座標
 *   GET  /api/breadth               市場の幅
 *   GET  /api/regime                相場レジーム判定
 *   GET  /api/correlation           相関行列・主成分・クラスタ
 *   GET  /api/factors               ファクターランキング
 *   GET  /api/outlook?region=US     セクター先行き見通しランキング
 *   GET  /api/news                  収集済みニュース + AI 概況要約
 *   GET  /api/pit/status            Point-in-Time ジャーナルの蓄積状況
 *   GET  /api/pit/export?from=&to=  PIT ジャーナルの NDJSON エクスポート (研究ラボ用)
 *   POST /api/refresh?shard=n&full=1  パイプライン手動実行
 *   GET  /*                         静的ダッシュボード
 */

function json(data: unknown, status = 200, maxAge = 120): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${maxAge}` : "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

function csvList(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * GET のクエリ文字列からスクリーナークエリを組む簡易文法。
 *   ?f=fundamentals.forwardPE:lte:15&f=risk.beta:lte:1.2&sort=factors.composite:desc
 * URL だけで条件を共有できるようにするため、POST と同じ表現力を
 * なるべく持たせてある。
 */
function parseGetQuery(url: URL): ScreenerQuery {
  const filters: Filter[] = url.searchParams.getAll("f").map((raw) => {
    const [field, op, value, value2] = raw.split(":");
    const numeric = value !== undefined && value !== "" && Number.isFinite(Number(value));
    return {
      field,
      op: (op ?? "gte") as Operator,
      value: numeric ? Number(value) : value === "true" ? true : value === "false" ? false : value,
      value2: value2 === undefined ? undefined : Number(value2),
    };
  });
  const sort = url.searchParams.getAll("sort").map((raw) => {
    const [field, dir] = raw.split(":");
    return { field, dir: (dir === "asc" ? "asc" : "desc") as "asc" | "desc" };
  });
  return {
    regions: csvList(url.searchParams.get("region")) as RegionId[] | undefined,
    sectors: csvList(url.searchParams.get("sector")) as SectorId[] | undefined,
    roles: csvList(url.searchParams.get("role")),
    symbols: csvList(url.searchParams.get("symbols")),
    filters: filters.length > 0 ? filters : undefined,
    sort: sort.length > 0 ? sort : undefined,
    fields: csvList(url.searchParams.get("fields")),
    limit: Number(url.searchParams.get("limit")) || undefined,
    offset: Number(url.searchParams.get("offset")) || undefined,
  };
}

function universePayload() {
  const regions = Object.entries(REGION_META).map(([id, m]) => ({
    id,
    ...m,
    count: UNIVERSE.filter((i) => i.region === id).length,
  }));
  const sectors = SECTOR_ORDER.map((id) => ({
    id,
    ...SECTOR_META[id],
    count: UNIVERSE.filter((i) => i.sector === id).length,
  }));
  return {
    version: VERSION,
    size: UNIVERSE.length,
    regions: regions.filter((r) => r.count > 0),
    sectors: sectors.filter((s) => s.count > 0),
    instruments: UNIVERSE.map((i) => ({
      symbol: i.symbol,
      name: i.name,
      nameJa: i.nameJa,
      region: i.region,
      sector: i.sector,
      role: i.role,
      assetClass: i.assetClass,
      currency: i.currency,
    })),
  };
}

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/health") {
    return json({ ok: true, service: "qaiz", version: VERSION, ts: Date.now() }, 200, 0);
  }
  if (path === "/api/universe") {
    return json(universePayload(), 200, 3600);
  }
  if (path === "/api/presets") {
    return json({ presets: PRESETS, fields: SUMMARY_FIELDS }, 200, 3600);
  }

  /* ---- Point-in-Time ジャーナル (研究ラボとの接続点) ----
   *
   * スナップショット (meta) が無くても答えられる必要がある。PIT の記録は
   * 分析結果とは独立に積み上がるもので、「まだ分析が終わっていないから
   * PIT も見られない」では退避のタイミングを逃す。 */
  if (path === "/api/pit/status") {
    return json(await pitStatus(env), 200, 60);
  }

  if (path === "/api/pit/export") {
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;
    const limit = Number(url.searchParams.get("limit")) || undefined;
    const records = await loadPitRecords(env, { from, to, limit });
    // NDJSON で返す。ラボ側は 1 行ずつ追記マージするので、配列より扱いやすい。
    return new Response(toNdjson(records), {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        // 観測は追記のみで書き換わらないが、新しい観測が増えるのでキャッシュは短く
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
        "X-QAIZ-PIT-Records": String(records.length),
      },
    });
  }

  if (path === "/api/refresh" && request.method === "POST") {
    const shardParam = url.searchParams.get("shard");
    const snapshot = await runPipeline(env, {
      shard: shardParam !== null ? Number(shardParam) : undefined,
      recomputeAll: url.searchParams.get("full") === "1",
    });
    return json(
      {
        ok: true,
        generatedAt: snapshot.generatedAt,
        covered: snapshot.meta.covered,
        universeSize: snapshot.meta.universeSize,
        shard: snapshot.meta.shard,
        shards: snapshot.meta.shards,
        fetches: snapshot.meta.fetches,
        elapsedMs: snapshot.meta.elapsedMs,
        errors: snapshot.meta.errors,
      },
      200,
      0
    );
  }

  const meta = await loadMeta(env);
  if (!meta) {
    // 初回アクセス: バックグラウンドで生成を始め、クライアントにはポーリングを促す
    ctx.waitUntil(runPipeline(env).catch(() => {}));
    return json(
      { status: "generating", message: "初回データを収集中。数十秒後に再読み込みしてください。" },
      503
    );
  }

  /* ---- 記録を要するエンドポイント ---- */
  const needsRecords =
    path === "/api/overview" ||
    path === "/api/screener" ||
    path === "/api/factors" ||
    path === "/api/compare" ||
    path.startsWith("/api/symbol/");

  const records = needsRecords ? await loadRecords(env) : {};
  const list = Object.values(records);

  const needsOutlook = path === "/api/overview" || path === "/api/outlook";
  const outlook = needsOutlook ? await loadOutlook(env) : null;

  switch (true) {
    case path === "/api/overview": {
      // ダッシュボードの初期描画に必要なものだけを 1 往復で返す。
      // 全レコードを載せると数百 KB になるので、上位だけ要約する。
      const top = runScreener(list, {
        roles: ["constituent", "sector-proxy"],
        sort: [{ field: "factors.composite", dir: "desc" }],
        limit: 25,
      });
      const bottom = runScreener(list, {
        roles: ["constituent", "sector-proxy"],
        sort: [{ field: "factors.composite", dir: "asc" }],
        limit: 10,
      });
      const macro = runScreener(list, {
        roles: ["macro", "benchmark"],
        sort: [{ field: "price.r1d", dir: "desc" }],
        limit: 40,
        fields: [
          "instrument.symbol", "instrument.nameJa", "instrument.region",
          "instrument.assetClass", "price.last", "price.currency",
          "price.r1d", "price.r1w", "price.r1m", "price.r3m", "price.ytd",
          "price.rangePosition52w", "technicals.rsi14",
        ],
      });
      return json({
        generatedAt: meta.generatedAt,
        version: meta.version,
        regime: meta.regime,
        breadth: meta.breadth,
        sectors: meta.sectors,
        rotation: meta.rotation,
        correlation: meta.correlation,
        news: meta.news.slice(0, 24),
        newsBrief: meta.newsBrief ?? null,
        outlook,
        leaders: top,
        laggards: bottom,
        macro,
        meta: meta.meta,
      });
    }

    case path === "/api/sectors": {
      const region = url.searchParams.get("region");
      const sectors = region
        ? meta.sectors.filter((s) => s.region === region)
        : meta.sectors;
      return json({ generatedAt: meta.generatedAt, sectors });
    }

    case path === "/api/rotation": {
      const region = url.searchParams.get("region");
      const rotation = region
        ? meta.rotation.filter((r) => r.region === region)
        : meta.rotation;
      return json({
        generatedAt: meta.generatedAt,
        method:
          "Zスコア正規化版 RS-Ratio / RS-Momentum (窓126日, モメンタム遅行10日)。" +
          "本家 JdK の平滑化とは異なるため絶対値は一致しない。",
        rotation,
      });
    }

    case path === "/api/breadth":
      return json({ generatedAt: meta.generatedAt, breadth: meta.breadth });

    case path === "/api/regime":
      return json({ generatedAt: meta.generatedAt, regime: meta.regime });

    case path === "/api/correlation":
      return json({ generatedAt: meta.generatedAt, correlation: meta.correlation });

    case path === "/api/news":
      return json({
        generatedAt: meta.generatedAt,
        brief: meta.newsBrief ?? null,
        news: meta.news,
      });

    case path === "/api/outlook": {
      if (!outlook) {
        return json(
          { error: "見通しがまだ生成されていない (初回のパイプライン実行待ち)" },
          404
        );
      }
      const region = url.searchParams.get("region");
      if (!region) return json({ generatedAt: meta.generatedAt, outlook });
      // 地域を絞る場合は、その地域の中で順位を振り直す。
      // 全体順位のまま抜き出すと「1位が無い一覧」になって読めない。
      const all = outlook.all.filter((r) => r.region === region);
      return json({
        generatedAt: meta.generatedAt,
        outlook: {
          ...outlook,
          bullish: outlook.bullish.filter((r) => r.region === region),
          bearish: outlook.bearish.filter((r) => r.region === region),
          all: all.map((r, i) => ({ ...r, rank: i + 1 })),
        },
      });
    }

    case path === "/api/meta":
      return json({ generatedAt: meta.generatedAt, version: meta.version, meta: meta.meta });

    case path === "/api/screener": {
      let query: ScreenerQuery;
      if (request.method === "POST") {
        try {
          query = (await request.json()) as ScreenerQuery;
        } catch {
          return json({ error: "invalid JSON body" }, 400);
        }
      } else {
        const presetId = url.searchParams.get("preset");
        if (presetId) {
          const preset = PRESETS.find((p) => p.id === presetId);
          if (!preset) return json({ error: `unknown preset: ${presetId}` }, 404);
          const overrides = parseGetQuery(url);
          query = {
            ...preset.query,
            regions: overrides.regions ?? preset.query.regions,
            sectors: overrides.sectors ?? preset.query.sectors,
            limit: overrides.limit ?? preset.query.limit,
          };
        } else {
          query = parseGetQuery(url);
        }
      }
      const result = runScreener(list, query);
      return json({ generatedAt: meta.generatedAt, ...result });
    }

    case path === "/api/factors": {
      const region = url.searchParams.get("region");
      const sector = url.searchParams.get("sector");
      const result = runScreener(list, {
        roles: ["constituent", "sector-proxy"],
        regions: region ? [region as RegionId] : undefined,
        sectors: sector ? [sector as SectorId] : undefined,
        sort: [{ field: "factors.composite", dir: "desc" }],
        limit: Number(url.searchParams.get("limit")) || 60,
        fields: [
          "instrument.symbol", "instrument.nameJa", "instrument.region", "instrument.sector",
          "factors.composite", "factors.value", "factors.quality", "factors.momentum",
          "factors.growth", "factors.lowVol", "factors.rank", "factors.peerCount",
          "valuation.score", "valuation.coverage", "quality.score", "growth.score",
          "technicals.compositeScore", "price.r3m", "price.r12m1m", "risk.vol252",
        ],
      });
      return json({
        generatedAt: meta.generatedAt,
        note:
          "value/quality/growth はセクター内の相対評価、momentum/lowVol はユニバース全体の相対評価。" +
          "composite はそれらの Z スコアを加重平均したもの。",
        ...result,
      });
    }

    case path === "/api/compare": {
      const symbols = csvList(url.searchParams.get("symbols")) ?? [];
      if (symbols.length === 0) return json({ error: "symbols= が必要" }, 400);
      const found = symbols
        .map((s) => records[s])
        .filter((r): r is InstrumentRecord => !!r);
      const missing = symbols.filter((s) => !records[s]);
      return json({ generatedAt: meta.generatedAt, records: found, missing });
    }

    case path.startsWith("/api/symbol/"): {
      const symbol = decodeURIComponent(path.slice("/api/symbol/".length));
      const rec = records[symbol];
      if (!rec) {
        const known = getInstrument(symbol);
        return json(
          {
            error: known
              ? `${symbol} はユニバースにあるがまだ収集されていない (シャード更新待ち)`
              : `${symbol} はユニバースに存在しない`,
            universeMember: !!known,
          },
          404
        );
      }
      // ピア (同一セクター) の相対位置を一緒に返す。単体の PER だけ見せても
      // 判断できないので、比較対象を必ず添える。
      const peers = list
        .filter(
          (r) =>
            r.instrument.sector === rec.instrument.sector &&
            r.instrument.symbol !== symbol &&
            r.instrument.role === rec.instrument.role
        )
        .slice(0, 12)
        .map((r) => ({
          symbol: r.instrument.symbol,
          nameJa: r.instrument.nameJa,
          region: r.instrument.region,
          forwardPE: r.fundamentals?.forwardPE ?? null,
          priceToBook: r.fundamentals?.priceToBook ?? null,
          returnOnEquity: r.fundamentals?.returnOnEquity ?? null,
          r3m: r.price.r3m,
          composite: r.factors?.composite ?? null,
        }));
      return json({ generatedAt: meta.generatedAt, record: rec, peers });
    }

    case path.startsWith("/api/history/"): {
      const symbol = decodeURIComponent(path.slice("/api/history/".length));
      const series = await loadSeries(env, [symbol]);
      const s = series[symbol];
      if (!s) return json({ error: `${symbol} の価格系列が無い` }, 404);
      const points = Number(url.searchParams.get("points")) || 260;
      return json({
        symbol,
        name: s.name,
        currency: s.currency,
        source: s.source,
        fetchedAt: s.fetchedAt,
        bars: s.bars.slice(-Math.min(520, Math.max(30, points))),
      });
    }

    default:
      return json({ error: "not found", path }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (e) {
        // 例外の中身をレスポンスに載せない。スタックトレースや内部パスが
        // そのまま外に出るうえ、この API は認証なしで誰でも叩ける。
        // 調査に必要な情報はログ側に出す (`wrangler tail` で読める)。
        console.error("api error", url.pathname, e);
        return json({ error: "internal error", path: url.pathname }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
} satisfies ExportedHandler<Env>;
