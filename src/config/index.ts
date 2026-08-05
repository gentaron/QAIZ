export const VERSION = "1.0.0";

/** キー不要の無料RSSフィード (ニュース/センチメントの取り込み口) */
export const RSS_FEEDS: { url: string; source: string; region: string }[] = [
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US", source: "Yahoo Finance", region: "US" },
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", source: "CNBC Markets", region: "US" },
  { url: "https://www.cnbc.com/id/19836768/device/rss/rss.html", source: "CNBC Economy", region: "US" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch", region: "US" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_marketpulse", source: "MarketWatch Pulse", region: "US" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", source: "NHK 経済", region: "JP" },
  { url: "https://assets.wor.jp/rss/rdf/reuters/business.rdf", source: "Reuters ビジネス", region: "JP" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph", region: "GLOBAL" },
];

/** 1 実行あたりの外部フェッチ既定上限 (Workers 無料プランのサブリクエスト上限 50 の内側) */
export const DEFAULT_FETCH_BUDGET = 44;

/** ユニバースの既定分割数 */
export const DEFAULT_SHARDS = 8;

export { SECTOR_META, REGION_META, SECTOR_ORDER, SECTOR_CYCLICALITY } from "./sectors.ts";
export {
  UNIVERSE,
  getInstrument,
  instrumentsByRole,
  instrumentsInRegion,
  sectorCells,
  shardUniverse,
} from "./universe.ts";
