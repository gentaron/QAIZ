import type { Env, Snapshot } from "./types";

/**
 * スナップショット永続化層 — Durable Object (SQLite バックエンド)。
 *
 * KV と違い、ネームスペースの手動作成や ID の設定が不要で、
 * `wrangler deploy` だけで自動プロビジョニングされる (無料プラン対応)。
 */

const SNAPSHOT_KEY = "snapshot:v1";

export class SnapshotStore {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "PUT") {
      const body = await request.text();
      await this.state.storage.put(SNAPSHOT_KEY, body);
      return new Response("ok");
    }
    const value = await this.state.storage.get<string>(SNAPSHOT_KEY);
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
