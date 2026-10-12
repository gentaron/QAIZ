/**
 * 外部フェッチの共通層。
 *
 * Workers 無料プランは 1 リクエスト処理あたりのサブリクエストが 50 本まで。
 * ユニバースを素直に全部取りに行くと確実に超えるので、予算オブジェクトを
 * 明示的に持ち回り、超えたら **静かに諦めるのではなく理由を記録して** 止める。
 * どの銘柄が予算切れで落ちたかを snapshot.meta.errors から追えるようにするため。
 */

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class FetchBudget {
  private used = 0;
  private reservedUsed = 0;
  readonly limit: number;
  /**
   * 後段の処理のために取り置く枠。
   *
   * パイプラインは「ニュース → 価格 → ファンダ → AI 要約」の順に走るが、
   * 価格取得は銘柄数だけ際限なく食えるので、素直に先着順にすると
   * AI 呼び出しが毎回必ず予算切れになる (= 概況の要約が一生出ない)。
   * 取り置き分は takeReserved からしか使えないようにして、後段が
   * 確実に自分の枠を持てるようにする。使い切らなかった取り置きは
   * 誰も使わないまま余るが、順序依存で機能が消えるよりはるかにましである。
   */
  readonly reserved: number;
  readonly skipped: string[] = [];

  constructor(limit: number, reserved = 0) {
    this.limit = Math.max(1, limit);
    this.reserved = Math.max(0, Math.min(reserved, this.limit - 1));
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** 取り置きを侵さない範囲の上限 */
  private get openLimit(): number {
    return this.limit - Math.max(0, this.reserved - this.reservedUsed);
  }

  /** 予算があれば消費して true。無ければ理由を記録して false */
  take(label: string, cost = 1): boolean {
    if (this.used + cost > this.openLimit) {
      if (this.skipped.length < 40) this.skipped.push(label);
      return false;
    }
    this.used += cost;
    return true;
  }

  /** 取り置き枠を優先的に使う (使い切ったら通常枠と同じ扱いになる) */
  takeReserved(label: string, cost = 1): boolean {
    if (this.used + cost > this.limit) {
      if (this.skipped.length < 40) this.skipped.push(label);
      return false;
    }
    this.used += cost;
    this.reservedUsed += cost;
    return true;
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Cloudflare エッジキャッシュの TTL (秒) */
  cacheTtl?: number;
  timeoutMs?: number;
}

/**
 * タイムアウト付き fetch。
 * 1 本の外部 API が固まったせいでパイプライン全体が落ちるのを防ぐ。
 */
export async function httpGet(
  url: string,
  opts: FetchOptions = {}
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json,text/plain,*/*", ...opts.headers },
      signal: controller.signal,
      cf: opts.cacheTtl ? { cacheTtl: opts.cacheTtl, cacheEverything: true } : undefined,
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 並列数を絞った map。外部APIへの礼儀と、同時接続の暴発防止 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
