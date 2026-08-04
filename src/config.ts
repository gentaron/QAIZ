import type { SectorDef } from "./types";

/**
 * セクター定義。
 * 米国 SPDR セクター ETF は流動性が高く Yahoo Finance 非公式APIで
 * キー無しで取得できるため、グローバルセクターの代理変数として使う。
 * 日本市場は東証ETFを併用。
 */
export const SECTORS: SectorDef[] = [
  { id: "tech",       nameJa: "テクノロジー",     nameEn: "Technology",             symbol: "XLK",  stooqSymbol: "xlk.us", keywords: ["semiconductor", "AI chips", "software", "technology stocks"] },
  { id: "semis",      nameJa: "半導体",           nameEn: "Semiconductors",         symbol: "SMH",  stooqSymbol: "smh.us", keywords: ["semiconductor", "chip", "TSMC", "NVIDIA"] },
  { id: "financials", nameJa: "金融",             nameEn: "Financials",             symbol: "XLF",  stooqSymbol: "xlf.us", keywords: ["banks", "interest rates", "financial stocks"] },
  { id: "energy",     nameJa: "エネルギー",       nameEn: "Energy",                 symbol: "XLE",  stooqSymbol: "xle.us", keywords: ["oil price", "crude", "energy stocks", "OPEC"] },
  { id: "health",     nameJa: "ヘルスケア",       nameEn: "Health Care",            symbol: "XLV",  stooqSymbol: "xlv.us", keywords: ["pharma", "biotech", "healthcare stocks"] },
  { id: "industrials",nameJa: "資本財",           nameEn: "Industrials",            symbol: "XLI",  stooqSymbol: "xli.us", keywords: ["industrials", "defense", "aerospace", "manufacturing"] },
  { id: "discretionary", nameJa: "一般消費財",    nameEn: "Consumer Discretionary", symbol: "XLY",  stooqSymbol: "xly.us", keywords: ["consumer spending", "retail", "e-commerce"] },
  { id: "staples",    nameJa: "生活必需品",       nameEn: "Consumer Staples",       symbol: "XLP",  stooqSymbol: "xlp.us", keywords: ["consumer staples", "food", "beverage stocks"] },
  { id: "utilities",  nameJa: "公益",             nameEn: "Utilities",              symbol: "XLU",  stooqSymbol: "xlu.us", keywords: ["utilities", "electricity demand", "power grid"] },
  { id: "materials",  nameJa: "素材",             nameEn: "Materials",              symbol: "XLB",  stooqSymbol: "xlb.us", keywords: ["commodities", "copper", "mining", "materials stocks"] },
  { id: "realestate", nameJa: "不動産",           nameEn: "Real Estate",            symbol: "XLRE", stooqSymbol: "xlre.us", keywords: ["real estate", "REIT", "housing market"] },
  { id: "communication", nameJa: "通信サービス",  nameEn: "Communication Services", symbol: "XLC",  stooqSymbol: "xlc.us", keywords: ["media", "telecom", "advertising", "social media stocks"] },
  { id: "gold",       nameJa: "金 (ゴールド)",    nameEn: "Gold",                   symbol: "GLD",  stooqSymbol: "gld.us", keywords: ["gold price", "safe haven", "inflation hedge"] },
  { id: "crypto",     nameJa: "暗号資産",         nameEn: "Crypto (BTC)",           symbol: "BTC-USD", keywords: ["bitcoin", "crypto", "ethereum"] },
  { id: "space",      nameJa: "宇宙・防衛",       nameEn: "Space & Defense",        symbol: "ARKX", stooqSymbol: "arkx.us", keywords: ["space industry", "satellite", "SpaceX", "rocket launch"] },
  { id: "jp-topix",   nameJa: "日本株 (TOPIX)",   nameEn: "Japan (TOPIX)",          symbol: "1306.T", keywords: ["日本株", "東証", "Nikkei", "Japan stocks"] },
];

/** 世界の主要指数 (地域ヒートマップ用) */
export const GLOBAL_INDICES: { symbol: string; name: string; region: string }[] = [
  { symbol: "^GSPC",     name: "S&P 500",        region: "US" },
  { symbol: "^IXIC",     name: "NASDAQ",         region: "US" },
  { symbol: "^N225",     name: "日経225",         region: "JP" },
  { symbol: "^STOXX50E", name: "EURO STOXX 50",  region: "EU" },
  { symbol: "^FTSE",     name: "FTSE 100",       region: "UK" },
  { symbol: "^HSI",      name: "ハンセン",        region: "HK" },
  { symbol: "000001.SS", name: "上海総合",        region: "CN" },
  { symbol: "^BSESN",    name: "SENSEX",         region: "IN" },
  { symbol: "^KS11",     name: "KOSPI",          region: "KR" },
  { symbol: "^GDAXI",    name: "DAX",            region: "DE" },
  { symbol: "^BVSP",     name: "BOVESPA",        region: "BR" },
  { symbol: "BTC-USD",   name: "Bitcoin",        region: "CRYPTO" },
];

/** キー不要の無料RSSフィード (金融ニュース / 「人の言葉」の取り込み口) */
export const RSS_FEEDS: { url: string; source: string }[] = [
  { url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US", source: "Yahoo Finance" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC Top News" },
  { url: "https://www.cnbc.com/id/10000664/device/rss/rss.html", source: "CNBC Markets" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", source: "MarketWatch" },
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://www3.nhk.or.jp/rss/news/cat5.xml", source: "NHK 経済" },
];

/** KV キー */
export const KV_SNAPSHOT_KEY = "snapshot:v1";
/** KV スナップショットのTTL (秒) — cron失敗時も25時間は前回値を配信 */
export const SNAPSHOT_TTL = 60 * 60 * 25;

export const VERSION = "0.1.0";
