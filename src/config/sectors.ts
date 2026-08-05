import type { RegionId, SectorId } from "../types.ts";

/** セクターのメタ情報。ID は GICS を基礎に、実務で切り出されるバケットを追加。 */
export const SECTOR_META: Record<
  SectorId,
  { nameJa: string; nameEn: string; gics: boolean; keywords: string[] }
> = {
  tech:          { nameJa: "情報技術",       nameEn: "Information Technology", gics: true,  keywords: ["technology stocks", "software", "cloud computing"] },
  semis:         { nameJa: "半導体",         nameEn: "Semiconductors",         gics: false, keywords: ["semiconductor", "chip demand", "foundry", "memory prices"] },
  software:      { nameJa: "ソフトウェア",   nameEn: "Software",               gics: false, keywords: ["enterprise software", "SaaS", "cloud spending"] },
  communication: { nameJa: "通信サービス",   nameEn: "Communication Services", gics: true,  keywords: ["telecom", "streaming", "digital advertising"] },
  discretionary: { nameJa: "一般消費財",     nameEn: "Consumer Discretionary", gics: true,  keywords: ["consumer spending", "retail sales", "e-commerce"] },
  staples:       { nameJa: "生活必需品",     nameEn: "Consumer Staples",       gics: true,  keywords: ["consumer staples", "food inflation", "beverage"] },
  energy:        { nameJa: "エネルギー",     nameEn: "Energy",                 gics: true,  keywords: ["oil price", "crude", "OPEC", "natural gas"] },
  financials:    { nameJa: "金融",           nameEn: "Financials",             gics: true,  keywords: ["financials", "interest rates", "credit spreads"] },
  banks:         { nameJa: "銀行",           nameEn: "Banks",                  gics: false, keywords: ["banks", "net interest margin", "loan growth"] },
  health:        { nameJa: "ヘルスケア",     nameEn: "Health Care",            gics: true,  keywords: ["healthcare", "pharma", "drug pricing"] },
  biotech:       { nameJa: "バイオテク",     nameEn: "Biotechnology",          gics: false, keywords: ["biotech", "FDA approval", "clinical trial"] },
  industrials:   { nameJa: "資本財",         nameEn: "Industrials",            gics: true,  keywords: ["industrials", "manufacturing", "capex"] },
  defense:       { nameJa: "防衛・宇宙",     nameEn: "Aerospace & Defense",    gics: false, keywords: ["defense spending", "aerospace", "military budget"] },
  materials:     { nameJa: "素材",           nameEn: "Materials",              gics: true,  keywords: ["commodities", "copper", "chemicals", "steel"] },
  utilities:     { nameJa: "公益",           nameEn: "Utilities",              gics: true,  keywords: ["utilities", "power demand", "electricity"] },
  realestate:    { nameJa: "不動産",         nameEn: "Real Estate",            gics: true,  keywords: ["real estate", "REIT", "office vacancy"] },
  gold:          { nameJa: "金・貴金属",     nameEn: "Gold & Precious Metals", gics: false, keywords: ["gold price", "safe haven", "inflation hedge"] },
  crypto:        { nameJa: "暗号資産",       nameEn: "Digital Assets",         gics: false, keywords: ["bitcoin", "crypto", "ethereum"] },
  broad:         { nameJa: "市場全体",       nameEn: "Broad Market",           gics: false, keywords: ["stock market", "equity outlook"] },
  macro:         { nameJa: "マクロ",         nameEn: "Macro",                  gics: false, keywords: ["inflation", "central bank", "bond yields"] },
};

export const REGION_META: Record<RegionId, { nameJa: string; nameEn: string; benchmark: string }> = {
  US:     { nameJa: "米国",         nameEn: "United States", benchmark: "^GSPC" },
  JP:     { nameJa: "日本",         nameEn: "Japan",         benchmark: "^N225" },
  EU:     { nameJa: "欧州",         nameEn: "Europe",        benchmark: "^STOXX50E" },
  UK:     { nameJa: "英国",         nameEn: "United Kingdom", benchmark: "^FTSE" },
  CN:     { nameJa: "中国本土",     nameEn: "China A",       benchmark: "000001.SS" },
  HK:     { nameJa: "香港",         nameEn: "Hong Kong",     benchmark: "^HSI" },
  IN:     { nameJa: "インド",       nameEn: "India",         benchmark: "^BSESN" },
  KR:     { nameJa: "韓国",         nameEn: "Korea",         benchmark: "^KS11" },
  TW:     { nameJa: "台湾",         nameEn: "Taiwan",        benchmark: "^TWII" },
  AU:     { nameJa: "豪州",         nameEn: "Australia",     benchmark: "^AXJO" },
  CA:     { nameJa: "カナダ",       nameEn: "Canada",        benchmark: "^GSPTSE" },
  BR:     { nameJa: "ブラジル",     nameEn: "Brazil",        benchmark: "^BVSP" },
  EM:     { nameJa: "新興国",       nameEn: "Emerging Markets", benchmark: "EEM" },
  GLOBAL: { nameJa: "グローバル",   nameEn: "Global",        benchmark: "ACWI" },
};

/** セクターの表示順 (ディフェンシブ ↔ シクリカルの実務的な並び) */
export const SECTOR_ORDER: SectorId[] = [
  "tech", "semis", "software", "communication",
  "discretionary", "industrials", "defense", "materials", "energy",
  "financials", "banks", "realestate",
  "health", "biotech", "staples", "utilities",
  "gold", "crypto", "broad", "macro",
];

/**
 * セクターの景気感応度。ローテーション分析でシクリカル/ディフェンシブの
 * どちらに資金が向いているかを測るのに使う。
 */
export const SECTOR_CYCLICALITY: Partial<Record<SectorId, "cyclical" | "defensive" | "neutral">> = {
  tech: "cyclical", semis: "cyclical", software: "cyclical", communication: "neutral",
  discretionary: "cyclical", industrials: "cyclical", defense: "defensive",
  materials: "cyclical", energy: "cyclical", financials: "cyclical", banks: "cyclical",
  realestate: "neutral", health: "defensive", biotech: "neutral",
  staples: "defensive", utilities: "defensive", gold: "defensive", crypto: "cyclical",
};
