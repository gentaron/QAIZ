import type { Bar, Series } from "../types.ts";
import { httpGet } from "./http.ts";

/**
 * Stooq 日次CSV (キー不要・無料) — Yahoo が落ちたときのフォールバック。
 *
 * 注意: Stooq の終値は配当調整されていない。Yahoo (adjclose) と混ぜると
 * 高配当銘柄のリターンに系統的なズレが出るので、どちらを使ったかを
 * Series.source に必ず残し、レコードの dataQuality に載せる。
 */
export async function fetchStooqDaily(
  stooqSymbol: string,
  displaySymbol: string,
  currency: string
): Promise<Series | null> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
  const res = await httpGet(url, { cacheTtl: 3600 });
  if (!res || !res.ok) return null;

  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 40 || !lines[0].startsWith("Date")) return null;

  const bars: Bar[] = [];
  // 2 年分あれば 200 日線も 52 週レンジも計算できる
  for (const line of lines.slice(Math.max(1, lines.length - 520))) {
    const cols = line.split(",");
    const t = Date.parse(`${cols[0]}T00:00:00Z`) / 1000;
    const o = parseFloat(cols[1]);
    const h = parseFloat(cols[2]);
    const l = parseFloat(cols[3]);
    const c = parseFloat(cols[4]);
    const v = parseFloat(cols[5]);
    if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
    bars.push({
      t,
      o: Number.isFinite(o) ? o : c,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      v: Number.isFinite(v) ? v : null,
    });
  }
  if (bars.length < 30) return null;

  return {
    symbol: displaySymbol,
    name: displaySymbol,
    currency,
    bars,
    source: "stooq",
    fetchedAt: new Date().toISOString(),
  };
}
