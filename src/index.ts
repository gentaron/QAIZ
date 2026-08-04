import { runPipeline } from "./scheduled.ts";
import { loadSnapshot, SnapshotStore } from "./storage.ts";
import type { Env } from "./types";

export { SnapshotStore };

/**
 * QAIZ — Quantum-geometric AI Zone
 * セクターモメンタム・ヒート予測をCloudflareエッジで配信するWorker。
 *
 * ルーティング:
 *   GET /api/snapshot   … 最新スナップショット全体
 *   GET /api/sectors    … セクターヒートランキングのみ
 *   GET /api/indices    … 世界指数クオートのみ
 *   GET /api/news       … 収集済みニュース
 *   POST /api/refresh   … パイプラインを手動実行
 *   GET /api/health     … ヘルスチェック
 *   GET /*              … 静的ダッシュボード (public/)
 *
 * 初回アクセス時 (スナップショット未生成) はバックグラウンドで
 * パイプラインを自動起動し、ダッシュボード側がポーリングして表示する。
 */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
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
        const snapshot = await runPipeline(env);
        return json({
          ok: true,
          generatedAt: snapshot.generatedAt,
          sectors: snapshot.sectors.length,
          indices: snapshot.indices.length,
        });
      }

      const snapshot = await loadSnapshot(env);
      if (!snapshot) {
        // 初回: バックグラウンドで生成を開始し、クライアントにはポーリングを促す
        ctx.waitUntil(runPipeline(env).catch(() => {}));
        return json({ status: "generating" }, 503);
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
