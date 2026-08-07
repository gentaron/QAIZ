import type { Bar, Env, InstrumentRecord, Series, Snapshot } from "./types.ts";
import type { YahooSession } from "./datasources/yahoo.ts";
import type { FactorSeries } from "./datasources/kenfrench.ts";

/**
 * 永続化層 — Durable Object (SQLite バックエンド)。
 *
 * `wrangler deploy` だけで自動プロビジョニングされるので、KV のような
 * ネームスペース作成や ID の貼り付けが要らない (無料プラン対応)。
 *
 * 保存を 3 種類に分けているのは、DO ストレージの 1 値あたりのサイズ上限
 * (128 KiB) があるため。全銘柄のレコードを 1 つの JSON にすると軽く超える。
 *   meta:v1      … スナップショットのうち銘柄レコード以外 (集計・レジーム等)
 *   rec:<symbol> … 銘柄 1 本ぶんの分析結果
 *   bars:<symbol>… 価格系列 (シャード更新なので、取っていない回でも
 *                  相関・ローテーション計算に使えるよう残しておく)
 */

const META_KEY = "meta:v1";
const CURSOR_KEY = "cursor:v1";
const SESSION_KEY = "session:yahoo";
const FACTORS_KEY = "factors:french:v1";
const SCORE_HISTORY_KEY = "scorehist:v1";

type MetaSnapshot = Omit<Snapshot, "records">;

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

export async function loadSnapshot(env: Env): Promise<Snapshot | null> {
  const meta = await loadMeta(env);
  if (!meta) return null;
  const records = await loadRecords(env);
  return { ...meta, records };
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

/* ---- Fama-French ファクター ---- */

/**
 * ファクター系列は週 1 回で十分。日次データだが Ken French の更新自体が
 * 数日遅れるので、頻繁に取りに行っても新しくならない。
 */
const FACTOR_TTL_MS = 7 * 24 * 3600 * 1000;

export async function loadFactors(env: Env): Promise<FactorSeries | null> {
  return kvGet<FactorSeries>(env, FACTORS_KEY);
}

export async function saveFactors(env: Env, f: FactorSeries): Promise<void> {
  await kvPut(env, FACTORS_KEY, f);
}

/** 取り直しが必要か (未取得、または 1 週間より古い) */
export function factorsStale(f: FactorSeries | null): boolean {
  if (!f || !f.days?.length) return true;
  const age = Date.now() - Date.parse(f.fetchedAt);
  return !Number.isFinite(age) || age > FACTOR_TTL_MS;
}

/* ---- スコア履歴 ---- */

/**
 * point-in-time のスコア履歴。
 *
 * 「QAIZ のスコアが将来のリターンを予測できるか」は、今のスナップショット
 * だけでは絶対に検証できない。今のスコアで銘柄を選んで過去リターンを測れば、
 * 選択自体が未来を見ているので必ず良い数字が出る。
 *
 * 正しく検証するには「その日の時点で何位だったか」の記録が要る。
 * 今は答えを出せないが、記録を始めておかないと永遠に出せないので、
 * 1 日 1 スナップショットずつ積む。
 */
export interface ScoreSnapshot {
  /** YYYY-MM-DD */
  date: string;
  /** シンボル → 総合スコア (0-100) */
  scores: Record<string, number>;
}

/** 保持日数。DO の 1 値 128KiB 上限に収まる範囲 */
const SCORE_HISTORY_DAYS = 400;

export async function loadScoreHistory(env: Env): Promise<ScoreSnapshot[]> {
  return (await kvGet<ScoreSnapshot[]>(env, SCORE_HISTORY_KEY)) ?? [];
}

/**
 * その日のスコアを 1 件だけ記録する。同じ日に複数回呼ばれても上書きし、
 * 1 日 1 レコードを保つ (cron は 15 分ごとに回るため)。
 */
export async function recordScores(
  env: Env,
  scores: Record<string, number>
): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const hist = await loadScoreHistory(env);
  const rounded: Record<string, number> = {};
  for (const [k, v] of Object.entries(scores)) rounded[k] = Math.round(v * 10) / 10;

  const idx = hist.findIndex((h) => h.date === date);
  if (idx >= 0) hist[idx] = { date, scores: rounded };
  else hist.push({ date, scores: rounded });

  hist.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = hist.slice(-SCORE_HISTORY_DAYS);
  await kvPut(env, SCORE_HISTORY_KEY, trimmed);
  return trimmed.length;
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
