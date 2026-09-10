import { kvDelete, kvGet, kvList, kvPut } from "./storage.ts";
import type { Consensus, Env, Fundamentals } from "./types.ts";

/**
 * Point-in-Time ジャーナル — 研究ラボ (lab/) との接続点。
 *
 * ## なぜ Worker がこれを持つのか
 *
 * 株価は後から取り直せる。2020 年の終値は今日でも取れる。
 * **しかし「2020 年時点の予想 PER」は、今日どこからも取れない。**
 *
 * Yahoo が返す forwardPE は「今の予想 EPS に基づく今の PER」であって、
 * 2020 年に市場が見ていた予想 PER ではない。目標株価・レーティング・
 * EPS 改定・空売り比率も同じで、無料で手に入るのは常に「現在」だけ。
 * 過去の予想 PER を買おうとすると、有料の Point-in-Time データベンダーが要る。
 *
 * ところがこの Worker は 15 分ごとの cron でその値を毎回見ている。
 * 見た瞬間に上書きして捨てているだけで、**観測した時刻とセットで残せば、
 * それはそのまま Point-in-Time 観測になる**。観測時刻 = available_at。
 *
 * 今日から記録すれば 1 年後には 1 年ぶんの履歴になる。
 * 記録しなかった日は永久に埋まらない。だから「あとで」ではなく最初に作る。
 *
 * ## 何を記録して、何を記録しないか
 *
 * 記録するのは **後から再構成できない値だけ**。
 *
 *   記録する … ファンダメンタルズ、アナリストコンセンサス、空売り比率
 *   記録しない … 価格、テクニカル、リターン、リスク指標、ファクタースコア
 *
 * 後者は価格系列から後でいくらでも再計算できる。両方を混ぜて保存すると、
 * ストレージを食うだけでなく「再取得不能な観測」と「単なるキャッシュ」の
 * 区別が付かなくなる。区別が付かないデータは PIT データとして使えない。
 *
 * ## 1 日 1 観測、先勝ち
 *
 * 同じ (日付, 銘柄) には最初の観測だけを残し、以後は上書きしない。
 *
 *   - 四半期単位でしか動かない値に、1 日 4 回の粒度は要らない
 *   - 上書きすると observed_at が後ろにずれ、「もっと早く知っていた」事実が消える
 *   - DO ストレージの消費が銘柄数 × 日数で収まる
 *
 * ## 保持期間とエクスポート
 *
 * DO は無限には持てないので `PIT_RETENTION_DAYS` を超えた日付を掃除する。
 * **掃除は取り返しがつかない**ので、ラボ側の `cli pit-sync` で
 * ローカル (data/point_in_time/) に吸い出しておくことが前提になる。
 * `/api/pit/status` が最古の日付と保持期限までの余裕を返すので、
 * それを見て吸い出す。
 */

export const PIT_SCHEMA_VERSION = "1";

/** DO に保持する日数。これを超えた日付はプルーニングの対象になる。 */
export const PIT_RETENTION_DAYS = 400;

/** 記録するファンダメンタルズのフィールド (再取得不能なものだけ) */
const FUNDAMENTAL_FIELDS = [
  "trailingPE", "forwardPE", "priceToBook", "priceToSales", "evToEbitda",
  "earningsYield", "fcfYield", "dividendYield", "payoutRatio",
  "returnOnEquity", "returnOnAssets", "returnOnInvestedCapital",
  "grossMargin", "operatingMargin", "profitMargin",
  "debtToEquity", "netDebtToEbitda", "currentRatio",
  "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
  "marketCap", "sharesOutstanding", "shortPercentOfFloat",
] as const satisfies readonly (keyof Fundamentals)[];

/** 記録するコンセンサスのフィールド */
const CONSENSUS_FIELDS = [
  "recommendationMean", "analystCount", "targetMean", "targetMedian",
  "upsideToTarget", "targetDispersion", "ratingMomentum",
] as const satisfies readonly (keyof Consensus)[];

export interface PitRecord {
  /** 観測日 (JST の暦日) */
  date: string;
  symbol: string;
  /** **実際に値を観測した時刻** (ISO 8601, UTC)。これが available_at になる */
  observed_at: string;
  source: string;
  schema_version: string;
  fundamentals: Record<string, number | null> | null;
  consensus: Record<string, number | null> | null;
}

/**
 * JST の暦日を返す。
 *
 * UTC の日付を使うと、日本時間の朝 9 時 (UTC 前日 24 時) の観測が前日扱いになり、
 * 「その日の寄りには知らなかった値」を前日の観測として記録してしまう。
 * available_at (observed_at) 自体は UTC のまま持つので実害は無いが、
 * 日付キーが 1 日ずれるとラボ側の as-of 結合が読みにくくなる。
 */
export function jstDate(ts: number = Date.now()): string {
  return new Date(ts + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function pickNumbers<T extends object>(
  src: T | null,
  fields: readonly (keyof T)[]
): Record<string, number | null> | null {
  if (!src) return null;
  const out: Record<string, number | null> = {};
  let any = false;
  for (const f of fields) {
    const v = src[f];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[f as string] = v;
      any = true;
    } else {
      // 欠損は null で明示的に残す。キーごと落とすと「取れなかった」と
      // 「そもそもそのフィールドが無かった」が区別できなくなる。
      out[f as string] = null;
    }
  }
  return any ? out : null;
}

export interface PitObservation {
  symbol: string;
  fundamentals: Fundamentals | null;
  consensus: Consensus | null;
}

/**
 * 今回のサイクルで **実際に取得した** 観測だけをジャーナルに追記する。
 *
 * 前回から引き継いだ値を渡してはいけない。引き継いだ値に今の時刻を付けると
 * observed_at が嘘になり、PIT データとしての価値が消える
 * (「もっと早く知っていた」情報を「今知った」ことにしてしまう)。
 *
 * @returns 実際に書き込んだ件数 (既存があればスキップされる)
 */
export async function recordPitObservations(
  env: Env,
  observations: PitObservation[],
  now: number = Date.now()
): Promise<number> {
  const date = jstDate(now);
  const observedAt = new Date(now).toISOString();
  let written = 0;

  for (const obs of observations) {
    const fundamentals = pickNumbers(obs.fundamentals, FUNDAMENTAL_FIELDS);
    const consensus = pickNumbers(obs.consensus, CONSENSUS_FIELDS);
    if (!fundamentals && !consensus) continue;

    const key = pitKey(date, obs.symbol);
    // 先勝ち。同じ日に 2 回目以降の観測が来ても上書きしない。
    const existing = await kvGet<PitRecord>(env, key).catch(() => null);
    if (existing) continue;

    const record: PitRecord = {
      date,
      symbol: obs.symbol,
      observed_at: observedAt,
      source: obs.fundamentals?.source ?? obs.consensus?.source ?? "unknown",
      schema_version: PIT_SCHEMA_VERSION,
      fundamentals,
      consensus,
    };
    await kvPut(env, key, record).catch(() => {});
    written++;
  }
  return written;
}

export function pitKey(date: string, symbol: string): string {
  return `pit:${date}:${symbol}`;
}

/** 日付昇順・銘柄昇順で読み出す。キーが `pit:<date>:<symbol>` なので文字列順で日付順になる。 */
export async function loadPitRecords(
  env: Env,
  opts: { from?: string; to?: string; limit?: number } = {}
): Promise<PitRecord[]> {
  const raw = await kvList<PitRecord>(env, "pit:");
  const out: PitRecord[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || !value.date) continue;
    const date = key.split(":")[1];
    if (opts.from && date < opts.from) continue;
    if (opts.to && date > opts.to) continue;
    out.push(value);
  }
  out.sort((a, b) =>
    a.date === b.date ? a.symbol.localeCompare(b.symbol) : a.date.localeCompare(b.date)
  );
  return opts.limit ? out.slice(0, opts.limit) : out;
}

export interface PitStatus {
  schemaVersion: string;
  records: number;
  days: number;
  symbols: number;
  oldest: string | null;
  newest: string | null;
  retentionDays: number;
  /** 最古のレコードが保持期限に達するまでの日数 */
  daysUntilPrune: number | null;
  warning: string | null;
  note: string;
}

export async function pitStatus(env: Env, now: number = Date.now()): Promise<PitStatus> {
  const records = await loadPitRecords(env);
  const dates = new Set(records.map((r) => r.date));
  const symbols = new Set(records.map((r) => r.symbol));
  const sorted = [...dates].sort();
  const oldest = sorted[0] ?? null;
  const newest = sorted[sorted.length - 1] ?? null;

  let daysUntilPrune: number | null = null;
  if (oldest) {
    const age = Math.floor((now - Date.parse(`${oldest}T00:00:00Z`)) / 86400000);
    daysUntilPrune = PIT_RETENTION_DAYS - age;
  }

  return {
    schemaVersion: PIT_SCHEMA_VERSION,
    records: records.length,
    days: dates.size,
    symbols: symbols.size,
    oldest,
    newest,
    retentionDays: PIT_RETENTION_DAYS,
    daysUntilPrune,
    warning:
      daysUntilPrune !== null && daysUntilPrune < 30
        ? `最古の観測 (${oldest}) が ${daysUntilPrune} 日でプルーニング対象になる。` +
          "ラボ側で `python -m qaiz_lab.cli pit-sync` を実行してローカルに退避すること。" +
          "退避せずに消えた観測は二度と再構成できない。"
        : null,
    note:
      "observed_at は Worker が実際に値を観測した時刻であり、推定値ではない。" +
      "研究側ではこれをそのまま available_at として使ってよい。",
  };
}

/**
 * 保持期限を超えた日付を削除する。
 *
 * 1 回の実行で削除する件数に上限を設けている。cron の実行時間は有限で、
 * 数千件を一度に消そうとすると途中で切れて中途半端な状態になる。
 * 少しずつ消せば、次のサイクルで続きから消える。
 */
export async function prunePit(
  env: Env,
  now: number = Date.now(),
  maxDeletes = 200
): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = jstDate(now - PIT_RETENTION_DAYS * 86400000);
  const raw = await kvList<PitRecord>(env, "pit:");
  let deleted = 0;

  for (const key of Object.keys(raw).sort()) {
    if (deleted >= maxDeletes) break;
    const date = key.split(":")[1];
    if (date && date < cutoff) {
      await kvDelete(env, key).catch(() => {});
      deleted++;
    }
  }
  return { deleted, cutoff };
}

/**
 * NDJSON (1 行 1 レコード) で書き出す。
 *
 * JSON 配列にしないのは、ラボ側が 1 行ずつ追記マージするため。配列だと
 * 差分追記のたびに全体を読み直すことになるうえ、途中で切れたときに
 * ファイル全体が壊れる。NDJSON なら壊れるのは最後の 1 行だけで済む。
 */
export function toNdjson(records: PitRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}
