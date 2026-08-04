import { KV_SNAPSHOT_KEY } from "./config";
import { runPipeline } from "./scheduled";
import type { Env, Snapshot } from "./types";

/**
 * QAIZ — Quantum-geometric AI Zone
 * セクターモメンタム・ヒート予測をCloudflareエッジで配信するWorker。
 *
 * ルーティング:
 *   GET /api/snapshot   … 最新スナップショット全体 (KVキャッシュ)
 *   GET /api/sectors    … セクターヒートランキングのみ
 *   GET /api/indices    … 世界指数クオートのみ
 *   GET /api/news       … 収集済みニュース
 *   POST /api/refresh   … パイプラインを手動実行 (初回セットアップ用)
 *   GET /api/health     … ヘルスチェック
 *   GET /*              … 静的ダッシュボード (public/)
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getSnapshot(env: Env): Promise<Snapshot | null> {
  return env.QAIZ_KV.get<Snapshot>(KV_SNAPSHOT_KEY, "json");
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      if (path === "/api/health") {
        return json({ ok: true, service: "qaiz", ts: Date.now() });
      }

      if (path === "/api/refresh" && request.method === "POST") {
        // 初回セットアップやデバッグ用。cron を待たずに実行できる。
        const snapshot = await runPipeline(env);
        return json({
          ok: true,
          generatedAt: snapshot.generatedAt,
          sectors: snapshot.sectors.length,
          indices: snapshot.indices.length,
        });
      }

      const snapshot = await getSnapshot(env);
      if (!snapshot) {
        return json(
          {
            error:
              "snapshot not ready — run `curl -X POST https://<worker>/api/refresh` once, or wait for the hourly cron",
          },
          503
        );
      }

      switch (path) {
        case "/api/snapshot":
          return json(snapshot);
        case "/api/sectors":
          return json({
            generatedAt: snapshot.generatedAt,
            sectors: snapshot.sectors,
          });
        case "/api/indices":
          return json({
            generatedAt: snapshot.generatedAt,
            indices: snapshot.indices,
          });
        case "/api/news":
          return json({
            generatedAt: snapshot.generatedAt,
            news: snapshot.news,
          });
        default:
          return json({ error: "not found" }, 404);
      }
    }

    // 静的ダッシュボード
    return env.ASSETS.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
} satisfies ExportedHandler<Env>;
