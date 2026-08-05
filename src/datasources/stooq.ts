import type { Bar, Series } from "../types.ts";

/**
 * Stooq 日次CSV (キー不要・無料) — Yahoo 失敗時のフォールバック。
 * https://stooq.com/q/d/l/?s=xlk.us&i=d
 */
export async function fetchStooqDaily(
  stooqSymbol: string,
  displaySymbol: string
): Promise<Series | null> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(
    stooqSymbol
  )}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "qaiz/0.1 (edge quant research)" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split("\n");
  // ヘッダ: Date,Open,High,Low,Close,Volume
  if (lines.length < 30 || !lines[0].startsWith("Date")) return null;

  const bars: Bar[] = [];
  // 直近 ~130 営業日分だけで十分
  for (const line of lines.slice(Math.max(1, lines.length - 130))) {
    const cols = line.split(",");
    const close = parseFloat(cols[4]);
    const t = Date.parse(cols[0] + "T00:00:00Z") / 1000;
    if (Number.isFinite(close) && Number.isFinite(t)) {
      bars.push({ t, c: close });
    }
  }
  if (bars.length < 20) return null;
  return { symbol: displaySymbol, name: displaySymbol, bars, source: "stooq" };
}
