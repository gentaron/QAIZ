import type { Ledger } from "./os/ledger.ts";
import type { Env, Snapshot } from "./types.ts";

/**
 * 永続化層 — Durable Object (SQLite バックエンド)。
 *
 * KV と違い、ネームスペースの手動作成や ID の設定が不要で、
 * `wrangler deploy` だけで自動プロビジョニングされる (無料プラン対応)。
 *
 * 保存するのは 2 つ:
 *   snapshot:v1 … 最新のセクター/指数/ニュース/量子OS出力
 *   ledger:v1   … 優位性台帳 (実行ごとに追記される計測ログ)
 *
 * 台帳をスナップショットと別キーにしているのは、**履歴が本体**だから。
 * 「その時どっちが速かったか」を積み上げないと、量子の出番がいつ来るかは
 * 分からない。スナップショットは上書きされても台帳は残る。
 */

const SNAPSHOT_KEY = "snapshot:v1";
const LEDGER_KEY = "ledger:v1";

export class SnapshotStore {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname === "/ledger" ? LEDGER_KEY : SNAPSHOT_KEY;

    if (request.method === "PUT") {
      const body = await request.text();
      await this.state.storage.put(key, body);
      return new Response("ok");
    }
    const value = await this.state.storage.get<string>(key);
    if (!value) return new Response("not found", { status: 404 });
    return new Response(value, {
      headers: { "Content-Type": "application/json" },
    });
  }
}

function stub(env: Env): DurableObjectStub {
  return env.SNAPSHOT_DO.get(env.SNAPSHOT_DO.idFromName("global"));
}

export async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  const res = await stub(env).fetch("https://do/snapshot");
  if (!res.ok) return null;
  return res.json<Snapshot>();
}

export async function saveSnapshot(env: Env, snap: Snapshot): Promise<void> {
  await stub(env).fetch("https://do/snapshot", {
    method: "PUT",
    body: JSON.stringify(snap),
  });
}

export async function loadLedger(env: Env): Promise<Ledger | null> {
  const res = await stub(env).fetch("https://do/ledger");
  if (!res.ok) return null;
  return res.json<Ledger>();
}

export async function saveLedger(env: Env, ledger: Ledger): Promise<void> {
  await stub(env).fetch("https://do/ledger", {
    method: "PUT",
    body: JSON.stringify(ledger),
  });
}
