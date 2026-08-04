import type { NewsItem } from "../types";

/**
 * GDELT DOC 2.0 API (キー不要・無料)。
 * 世界中のニュース記事を横断検索できる「地球規模の言論センサー」。
 * セクターのキーワードで直近24時間の記事を引き、センチメント材料に加える。
 * https://api.gdeltproject.org/api/v2/doc/doc
 */

interface GdeltArticle {
  url: string;
  title: string;
  seendate: string;
  domain: string;
}

export async function fetchGdeltArticles(
  keywords: string[],
  maxRecords = 8
): Promise<NewsItem[]> {
  const query = keywords.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?query=" +
    encodeURIComponent(`(${query}) sourcelang:english`) +
    `&mode=artlist&format=json&maxrecords=${maxRecords}&timespan=1d&sort=hybridrel`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "qaiz/0.1 research" },
      cf: { cacheTtl: 1800, cacheEverything: true },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { articles?: GdeltArticle[] };
    return (json.articles ?? []).map((a) => ({
      title: a.title,
      link: a.url,
      pubDate: a.seendate,
      source: `GDELT:${a.domain}`,
    }));
  } catch {
    return [];
  }
}
