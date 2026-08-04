import type { NewsItem } from "../types";
import { RSS_FEEDS } from "../config.ts";

/**
 * RSS/Atom フィード取り込み (キー不要・無料)。
 * Workers には DOMParser が無いので正規表現ベースの軽量パーサで
 * <item>/<entry> の title / link / pubDate を抽出する。
 */

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function extract(tagBlock: string, tag: string): string {
  const m = tagBlock.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")
  );
  return m ? decodeEntities(m[1]) : "";
}

export function parseFeed(xml: string, source: string, limit = 12): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks.slice(0, limit)) {
    const title = extract(block, "title");
    let link = extract(block, "link");
    if (!link) {
      // Atom: <link href="..."/>
      const m = block.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : "";
    }
    const pubDate =
      extract(block, "pubDate") ||
      extract(block, "published") ||
      extract(block, "updated");
    if (title) items.push({ title, link, pubDate, source });
  }
  return items;
}

export async function fetchAllNews(perFeedLimit = 10): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "qaiz/0.1 rss reader" },
        cf: { cacheTtl: 900, cacheEverything: true },
      });
      if (!res.ok) return [] as NewsItem[];
      return parseFeed(await res.text(), feed.source, perFeedLimit);
    })
  );
  const news: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") news.push(...r.value);
  }
  return news;
}
