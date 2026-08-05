import { VERSION } from "./config.ts";
import { runPipeline } from "./scheduled.ts";
import { loadLedger, loadSnapshot, SnapshotStore } from "./storage.ts";
import { runBasketJob, runTailRiskJob } from "./os/kernel.ts";
import { basketReturns, covarianceMatrix } from "./problems/basket.ts";
import { qpuConfigured } from "./os/qpu.ts";
import type { Env } from "./types.ts";

export { SnapshotStore };

/**
 * QAIZ — Quantum Advantage Instrumentation Zone
 * セクター選択と尾リスク推定を量子OS経由で解き、Cloudflareエッジから配信する Worker。
 *
 * ルーティング:
 *   GET  /api/snapshot        … 最新スナップショット全体
 *   GET  /api/sectors         … セクターヒートランキング
 *   GET  /api/indices         … 世界指数クオート
 *   GET  /api/news            … 収集済みニュース
 *   GET  /api/basket          … 量子OSが選んだバスケットと尾リスク
 *   GET  /api/quantum/ledger  … 優位性台帳 (バックエンド横並びの実測履歴)
 *   GET  /api/quantum/status  … OS 構成と実機QPUの接続状態
 *   POST /api/quantum/solve   … 任意の問題をその場で解く (全バックエンド横並び)
 *   POST /api/refresh         … パイプライン手動実行
 *   GET  /api/health          … ヘルスチェック
 *   GET  /*                   … 静的ダッシュボード (public/)
 *
 * 初回アクセス時 (スナップショット未生成) はバックグラウンドで
 * パイプラインを自動起動し、ダッシュボード側がポーリングして表示する。
 */

/**
 * その場で問題を解く。ダッシュボードの「もっと大きい n で試す」ボタンと、
 * ベンチマークスクリプトの両方がここを叩く。
 *
 * 入力の μ / Σ を呼び出し側から渡せるようにしてあるのは、
 * **優位性の主張を第三者が再現できるようにするため**。
 * 市場データに依存した数字だけを見せて「量子が効いた」と言うのは検証不能。
 */
async function solveOnDemand(request: Request, env: Env): Promise<Response> {
  let body: {
    n?: number;
    cardinality?: number;
    riskAversion?: number;
    budgetMs?: number;
    seed?: number;
    epsilon?: number;
    mu?: number[];
    returns?: number[][];
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const budgetMs = clampNumber(body.budgetMs ?? 200, 1, 5000);
  const seed = body.seed ?? 20260805;

  if (!body.returns || body.returns.length === 0) {
    return json(
      { error: "returns[][] (資産×時系列) が必要。mu を省略すると平均リターンを使う" },
      400
    );
  }
  const returns = body.returns;
  const n = returns.length;
  if (n < 2 || n > 20) return json({ error: "n は 2..20" }, 400);
  const cardinality = clampNumber(body.cardinality ?? Math.ceil(n / 3), 1, n - 1);

  const mu =
    body.mu && body.mu.length === n
      ? Float64Array.from(body.mu)
      : Float64Array.from(
          returns.map((r) => r.reduce((a, b) => a + b, 0) / Math.max(1, r.length))
        );
  const sigma = covarianceMatrix(returns);
  const ids = Array.from({ length: n }, (_, i) => `A${i}`);

  const basket = runBasketJob(
    {
      ids,
      mu,
      sigma,
      cardinality,
      riskAversion: body.riskAversion ?? 1,
    },
    { budgetMs: budgetMs * 0.7, seed }
  );

  const risk = runTailRiskJob(
    {
      returns: basketReturns(returns, basket.solution.mask),
      epsilon: clampNumber(body.epsilon ?? 0.01, 0.001, 0.2),
      bins: 32,
    },
    { budgetMs: budgetMs * 0.3, seed }
  );

  return json({
    basket: {
      selected: basket.solution.selected,
      feasible: basket.solution.feasible,
      objective: basket.solution.objective,
      matchesExact: basket.exact
        ? basket.exact.mask === basket.solution.mask
        : null,
    },
    exactEnumerationWallAt: basket.exactWallAt,
    ledger: [basket.entry, risk.entry],
    env: {
      qpuConfigured: qpuConfigured({
        endpoint: env.QPU_ENDPOINT,
        token: env.QPU_TOKEN,
        backend: env.QPU_BACKEND,
      }),
    },
  });
}

function clampNumber(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo;
}

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
          quantum: snapshot.quantum !== null,
        });
      }

      if (path === "/api/quantum/status") {
        return json({
          os: "qaiz-quantum-os",
          version: VERSION,
          budgetMs: Number(env.QUANTUM_BUDGET_MS ?? 120),
          problems: [
            {
              id: "basket-qubo",
              name: "基数制約付きセクターバスケット選択",
              complexity: "NP困難 (二次ナップサック / k-densest subgraph を含む)",
              quantumRoute: "QAOA+ (XYミキサー + Dicke状態)",
              advantageStatus:
                "未確立 — 現在の規模では厳密解が一瞬で出るため優位性は無い",
            },
            {
              id: "tail-amplitude",
              name: "バスケットのテールリスク推定",
              complexity: "確率推定 (古典は Θ(1/ε²) サンプル)",
              quantumRoute: "Iterative Quantum Amplitude Estimation",
              advantageStatus:
                "証明済み — クエリ計算量 O(1/ε) の二次高速化 (BHMT 2002)",
            },
          ],
          backends: [
            { id: "exact-enumeration", kind: "classical" },
            { id: "simulated-annealing", kind: "classical" },
            { id: "monte-carlo", kind: "classical" },
            { id: "qaoa-xy-statevector", kind: "quantum-sim" },
            { id: "iqae-statevector", kind: "quantum-sim" },
            {
              id: "qpu",
              kind: "quantum-hardware",
              configured: qpuConfigured({
                endpoint: env.QPU_ENDPOINT,
                token: env.QPU_TOKEN,
                backend: env.QPU_BACKEND,
              }),
            },
          ],
        });
      }

      if (path === "/api/quantum/ledger") {
        const ledger = await loadLedger(env);
        return json(ledger ?? { version: 1, entries: [] });
      }

      if (path === "/api/quantum/solve" && request.method === "POST") {
        return solveOnDemand(request, env);
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
        case "/api/basket":
          return snapshot.quantum
            ? json({
                generatedAt: snapshot.generatedAt,
                ...snapshot.quantum,
              })
            : json({ error: "quantum decision not available" }, 503);
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
