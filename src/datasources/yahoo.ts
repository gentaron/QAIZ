import type { Bar, Series } from "../types";

/**
 * Yahoo Finance 非公式 chart API (キー不要・無料)。
 * https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 * 世界中の株価指数・ETF・暗号資産・為替をカバーする。
 */

interface YahooChartResponse {
  chart: {
    result?: {
      meta: { symbol: string; shortName?: string; longName?: string };
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[] }[] };
    }[];
    error?: { code: string; description: string } | null;
  };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchYahooDaily(
  symbol: string,
  range = "6mo"
): Promise<Series | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cf: { cacheTtl: 900, cacheEverything: true },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp) return null;

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const bars: Bar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const c = closes[i];
    if (c != null && Number.isFinite(c)) {
      bars.push({ t: result.timestamp[i], c });
    }
  }
  if (bars.length < 20) return null;
  return {
    symbol,
    name: result.meta.shortName ?? result.meta.longName ?? symbol,
    bars,
    source: "yahoo",
  };
}
