import type { Bar, Env, InstrumentRecord, OutlookBoard, Series, Snapshot } from "./types.ts";
import type { YahooSession } from "./datasources/yahoo.ts";

/**
 * 永続化層 — Durable Object (SQLite バックエンド)。
 *
 * `wrangler deploy` だけで自動プロビジョニングされるので、KV のような
 * ネームスペース作成や ID の貼り付けが要らない (無料プラン対応)。
 *
 * 保存を 3 種類に分けているのは、DO ストレージの 1 値あたりのサイズ上限
 * (128 KiB) があるため。全銘柄のレコードを 1 つの JSON にすると軽く超える。
 *   meta:v1      … スナップショットのうち銘柄レコード以外 (集計・レジーム等)
 *   outlook:v1   … セクター見通し (柱の内訳を持つので meta とは分ける)
 *   rec:<symbol> … 銘柄 1 本ぶんの分析結果
 *   bars:<symbol>… 価格系列 (シャード更新なので、取っていない回でも
 *                  相関・ローテーション計算に使えるよう残しておく)
 */

const META_KEY = "meta:v1";
const OUTLOOK_KEY = "outlook:v1";
const CURSOR_KEY = "cursor:v1";
const SESSION_KEY = "session:yahoo";

type MetaSnapshot = Omit<Snapshot, "records" | "outlook">;

interface RpcRequest {
  op: "get" | "put" | "delete" | "list" | "mget";
  key?: string;
  keys?: string[];
  prefix?: string;
  value?: unknown;
}

export class AnalyticsStore {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let req: RpcRequest;
    try {
      req = (await request.json()) as RpcRequest;
    } catch {
      return json({ error: "bad request" }, 400);
    }

    switch (req.op) {
      case "get": {
        const v = await this.state.storage.get(req.key!);
        return json({ value: v ?? null });
      }
      case "mget": {
        // DO の get は 128 キーまでまとめて引ける。超える場合は分割する。
        const keys = req.keys ?? [];
        const out: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i += 120) {
          const chunk = keys.slice(i, i + 120);
          const m = await this.state.storage.get<unknown>(chunk);
          for (const [k, v] of m) out[k] = v;
        }
        return json({ values: out });
      }
      case "put":
        await this.state.storage.put(req.key!, req.value);
        return json({ ok: true });
      case "delete":
        await this.state.storage.delete(req.key!);
        return json({ ok: true });
      case "list": {
        const m = await this.state.storage.list<unknown>({ prefix: req.prefix ?? "" });
        const out: Record<string, unknown> = {};
        for (const [k, v] of m) out[k] = v;
        return json({ values: out });
      }
      default:
        return json({ error: "unknown op" }, 400);
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ------------------------------------------------------------------ */
/* クライアント                                                        */
/* ------------------------------------------------------------------ */

function stub(env: Env): DurableObjectStub {
  return env.STORE.get(env.STORE.idFromName("global"));
}

async function rpc<T>(env: Env, body: RpcRequest): Promise<T> {
  const res = await stub(env).fetch("https://store/rpc", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res.json<T>();
}

export async function kvGet<T>(env: Env, key: string): Promise<T | null> {
  const { value } = await rpc<{ value: T | null }>(env, { op: "get", key });
  return value ?? null;
}

export async function kvPut(env: Env, key: string, value: unknown): Promise<void> {
  await rpc(env, { op: "put", key, value });
}

export async function kvDelete(env: Env, key: string): Promise<void> {
  await rpc(env, { op: "delete", key });
}

export async function kvList<T>(env: Env, prefix: string): Promise<Record<string, T>> {
  const { values } = await rpc<{ values: Record<string, T> }>(env, { op: "list", prefix });
  return values ?? {};
}

export async function kvMget<T>(env: Env, keys: string[]): Promise<Record<string, T>> {
  if (keys.length === 0) return {};
  const { values } = await rpc<{ values: Record<string, T> }>(env, { op: "mget", keys });
  return values ?? {};
}

/* ---- 高レベル API ---- */

export async function loadMeta(env: Env): Promise<MetaSnapshot | null> {
  return kvGet<MetaSnapshot>(env, META_KEY);
}

export async function saveMeta(env: Env, meta: MetaSnapshot): Promise<void> {
  await kvPut(env, META_KEY, meta);
}

export async function loadRecords(env: Env): Promise<Record<string, InstrumentRecord>> {
  const raw = await kvList<InstrumentRecord>(env, "rec:");
  const out: Record<string, InstrumentRecord> = {};
  for (const [k, v] of Object.entries(raw)) out[k.slice(4)] = v;
  return out;
}

export async function saveRecord(env: Env, rec: InstrumentRecord): Promise<void> {
  await kvPut(env, `rec:${rec.instrument.symbol}`, rec);
}

export async function loadOutlook(env: Env): Promise<OutlookBoard | null> {
  return kvGet<OutlookBoard>(env, OUTLOOK_KEY);
}

export async function saveOutlook(env: Env, outlook: OutlookBoard | null): Promise<void> {
  await kvPut(env, OUTLOOK_KEY, outlook);
}

export async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  const meta = await loadMeta(env);
  if (!meta) return null;
  const [records, outlook] = await Promise.all([loadRecords(env), loadOutlook(env)]);
  return { ...meta, outlook, records };
}

/* ---- 価格系列のキャッシュ ---- */

/** [t, o, h, l, c, v] のタプル配列。JSON サイズを 1/3 程度に抑える */
type CompactBar = [number, number, number, number, number, number | null];

interface CachedSeries {
  s: string;
  n: string;
  cur: string;
  src: Series["source"];
  at: string;
  b: CompactBar[];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export async function saveSeries(env: Env, series: Series): Promise<void> {
  const payload: CachedSeries = {
    s: series.symbol,
    n: series.name,
    cur: series.currency,
    src: series.source,
    at: series.fetchedAt,
    // 2 年 (約 504 本) あれば 200日線・52週レンジ・年次リスクが全部計算できる
    b: series.bars.slice(-520).map((b) => [b.t, r4(b.o), r4(b.h), r4(b.l), r4(b.c), b.v] as CompactBar),
  };
  await kvPut(env, `bars:${series.symbol}`, payload);
}

function expand(c: CachedSeries): Series {
  const bars: Bar[] = c.b.map(([t, o, h, l, cl, v]) => ({ t, o, h, l, c: cl, v }));
  return { symbol: c.s, name: c.n, currency: c.cur, bars, source: c.src, fetchedAt: c.at };
}

export async function loadAllSeries(env: Env): Promise<Record<string, Series>> {
  const raw = await kvList<CachedSeries>(env, "bars:");
  const out: Record<string, Series> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && Array.isArray(v.b)) out[k.slice(5)] = expand(v);
  }
  return out;
}

export async function loadSeries(env: Env, symbols: string[]): Promise<Record<string, Series>> {
  const raw = await kvMget<CachedSeries>(env, symbols.map((s) => `bars:${s}`));
  const out: Record<string, Series> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && Array.isArray(v.b)) out[k.slice(5)] = expand(v);
  }
  return out;
}

/* ---- シャードカーソルと Yahoo セッション ---- */

export async function nextShard(env: Env, shards: number): Promise<number> {
  const cur = (await kvGet<number>(env, CURSOR_KEY)) ?? -1;
  const next = (cur + 1) % Math.max(1, shards);
  await kvPut(env, CURSOR_KEY, next);
  return next;
}

/** crumb セッションは 6 時間キャッシュする (毎回 2 リクエスト使うのは無駄) */
export async function loadSession(env: Env): Promise<YahooSession | null> {
  const s = await kvGet<YahooSession>(env, SESSION_KEY);
  if (!s || !s.crumb || Date.now() - s.obtainedAt > 6 * 3600 * 1000) return null;
  return s;
}

export async function saveSession(env: Env, session: YahooSession): Promise<void> {
  await kvPut(env, SESSION_KEY, session);
}
