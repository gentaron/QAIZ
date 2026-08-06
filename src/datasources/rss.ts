import type { NewsItem } from "../types.ts";
import { RSS_FEEDS } from "../config/index.ts";
import { httpGet } from "./http.ts";
import type { FetchBudget } from "./http.ts";

/**
 * RSS/Atom 取り込み (キー不要・無料)。
 * Workers に DOMParser は無いので、正規表現ベースの軽量パーサで
 * <item>/<entry> の title / link / pubDate を抜く。
 */

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extract(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

export function parseFeed(xml: string, source: string, limit = 12): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks.slice(0, limit)) {
    const title = extract(block, "title");
    let link = extract(block, "link");
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : "";
    }
    const pubDate =
      extract(block, "pubDate") || extract(block, "published") || extract(block, "updated") ||
      extract(block, "dc:date");
    if (title) items.push({ title, link, pubDate, source });
  }
  return items;
}

export async function fetchNews(
  budget: FetchBudget,
  perFeedLimit = 8
): Promise<NewsItem[]> {
  const feeds = RSS_FEEDS.filter(() => budget.take("rss"));
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await httpGet(feed.url, { cacheTtl: 900, timeoutMs: 6000 });
      if (!res || !res.ok) return [] as NewsItem[];
      return parseFeed(await res.text(), feed.source, perFeedLimit);
    })
  );
  const news: NewsItem[] = [];
  for (const r of results) if (r.status === "fulfilled") news.push(...r.value);

  // 同一見出しの重複を落としつつ、新しい順に寄せる
  const seen = new Set<string>();
  return news.filter((n) => {
    const key = n.title.slice(0, 80).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
