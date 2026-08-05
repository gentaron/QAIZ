import type { Instrument, RegionId, SectorId } from "../types.ts";

/**
 * 分析ユニバース。
 *
 * 構成方針:
 *  - 各地域 × セクターに「代表 ETF (sector-proxy)」を 1 本置く。セクターの
 *    リターン・テクニカルはここから取る。指数より ETF を優先するのは、
 *    出来高が取れて需給の判断材料が増えるため。
 *  - その下に「代表構成銘柄 (constituent)」を数本置く。PER/PBR/ROE のような
 *    ファンダメンタルズは ETF では取れないので、セクターのバリュエーションは
 *    構成銘柄の中央値で代表させる。
 *  - benchmark はリスク計測 (β・相関) の基準、macro はレジーム判定の入力。
 *
 * priority が小さいものから取りに行く。無料枠のサブリクエスト上限に当たった
 * ときに落ちるのは priority の大きい銘柄だけになるようにしてある。
 */

function inst(
  symbol: string,
  name: string,
  nameJa: string,
  region: RegionId,
  sector: SectorId,
  role: Instrument["role"],
  assetClass: Instrument["assetClass"],
  currency: string,
  extra: Partial<Instrument> = {}
): Instrument {
  return { symbol, name, nameJa, region, sector, role, assetClass, currency, ...extra };
}

/* ---------------- 米国: セクター ETF ---------------- */
const US_SECTOR_ETFS: Instrument[] = [
  inst("XLK",  "Technology Select Sector SPDR", "米国 情報技術", "US", "tech", "sector-proxy", "etf", "USD", { stooq: "xlk.us", priority: 1 }),
  inst("SMH",  "VanEck Semiconductor ETF",      "米国 半導体",   "US", "semis", "sector-proxy", "etf", "USD", { stooq: "smh.us", priority: 1 }),
  inst("IGV",  "iShares Expanded Tech-Software","米国 ソフトウェア","US","software","sector-proxy","etf","USD", { stooq: "igv.us", priority: 2 }),
  inst("XLC",  "Communication Services SPDR",   "米国 通信サービス","US","communication","sector-proxy","etf","USD", { stooq: "xlc.us", priority: 1 }),
  inst("XLY",  "Consumer Discretionary SPDR",   "米国 一般消費財","US","discretionary","sector-proxy","etf","USD", { stooq: "xly.us", priority: 1 }),
  inst("XLP",  "Consumer Staples SPDR",         "米国 生活必需品","US","staples","sector-proxy","etf","USD", { stooq: "xlp.us", priority: 1 }),
  inst("XLE",  "Energy Select Sector SPDR",     "米国 エネルギー","US","energy","sector-proxy","etf","USD", { stooq: "xle.us", priority: 1 }),
  inst("XLF",  "Financial Select Sector SPDR",  "米国 金融",     "US","financials","sector-proxy","etf","USD", { stooq: "xlf.us", priority: 1 }),
  inst("KBE",  "SPDR S&P Bank ETF",             "米国 銀行",     "US","banks","sector-proxy","etf","USD", { stooq: "kbe.us", priority: 2 }),
  inst("XLV",  "Health Care Select Sector SPDR","米国 ヘルスケア","US","health","sector-proxy","etf","USD", { stooq: "xlv.us", priority: 1 }),
  inst("XBI",  "SPDR S&P Biotech ETF",          "米国 バイオテク","US","biotech","sector-proxy","etf","USD", { stooq: "xbi.us", priority: 2 }),
  inst("XLI",  "Industrial Select Sector SPDR", "米国 資本財",   "US","industrials","sector-proxy","etf","USD", { stooq: "xli.us", priority: 1 }),
  inst("ITA",  "iShares Aerospace & Defense",   "米国 防衛・宇宙","US","defense","sector-proxy","etf","USD", { stooq: "ita.us", priority: 2 }),
  inst("XLB",  "Materials Select Sector SPDR",  "米国 素材",     "US","materials","sector-proxy","etf","USD", { stooq: "xlb.us", priority: 1 }),
  inst("XLU",  "Utilities Select Sector SPDR",  "米国 公益",     "US","utilities","sector-proxy","etf","USD", { stooq: "xlu.us", priority: 1 }),
  inst("XLRE", "Real Estate Select Sector SPDR","米国 不動産",   "US","realestate","sector-proxy","etf","USD", { stooq: "xlre.us", priority: 1 }),
  inst("GLD",  "SPDR Gold Shares",              "金 (ゴールド)", "US","gold","sector-proxy","etf","USD", { stooq: "gld.us", priority: 2 }),
];

/* ---------------- 米国: 代表構成銘柄 ---------------- */
const US_CONSTITUENTS: Instrument[] = [
  // Tech / Semis / Software
  inst("AAPL", "Apple",              "アップル",         "US", "tech", "constituent", "equity", "USD", { priority: 1 }),
  inst("MSFT", "Microsoft",          "マイクロソフト",   "US", "software", "constituent", "equity", "USD", { priority: 1 }),
  inst("NVDA", "NVIDIA",             "エヌビディア",     "US", "semis", "constituent", "equity", "USD", { priority: 1 }),
  inst("AVGO", "Broadcom",           "ブロードコム",     "US", "semis", "constituent", "equity", "USD", { priority: 2 }),
  inst("AMD",  "Advanced Micro Devices", "AMD",         "US", "semis", "constituent", "equity", "USD", { priority: 3 }),
  inst("MU",   "Micron Technology",  "マイクロン",       "US", "semis", "constituent", "equity", "USD", { priority: 3 }),
  inst("ORCL", "Oracle",             "オラクル",         "US", "software", "constituent", "equity", "USD", { priority: 3 }),
  inst("CRM",  "Salesforce",         "セールスフォース", "US", "software", "constituent", "equity", "USD", { priority: 3 }),
  inst("ADBE", "Adobe",              "アドビ",           "US", "software", "constituent", "equity", "USD", { priority: 3 }),
  // Communication
  inst("GOOGL","Alphabet",           "アルファベット",   "US", "communication", "constituent", "equity", "USD", { priority: 1 }),
  inst("META", "Meta Platforms",     "メタ",             "US", "communication", "constituent", "equity", "USD", { priority: 2 }),
  inst("NFLX", "Netflix",            "ネットフリックス", "US", "communication", "constituent", "equity", "USD", { priority: 3 }),
  // Discretionary
  inst("AMZN", "Amazon.com",         "アマゾン",         "US", "discretionary", "constituent", "equity", "USD", { priority: 1 }),
  inst("TSLA", "Tesla",              "テスラ",           "US", "discretionary", "constituent", "equity", "USD", { priority: 2 }),
  inst("HD",   "Home Depot",         "ホームデポ",       "US", "discretionary", "constituent", "equity", "USD", { priority: 3 }),
  // Staples
  inst("PG",   "Procter & Gamble",   "P&G",              "US", "staples", "constituent", "equity", "USD", { priority: 2 }),
  inst("KO",   "Coca-Cola",          "コカ・コーラ",     "US", "staples", "constituent", "equity", "USD", { priority: 3 }),
  inst("COST", "Costco",             "コストコ",         "US", "staples", "constituent", "equity", "USD", { priority: 3 }),
  // Energy
  inst("XOM",  "Exxon Mobil",        "エクソンモービル", "US", "energy", "constituent", "equity", "USD", { priority: 2 }),
  inst("CVX",  "Chevron",            "シェブロン",       "US", "energy", "constituent", "equity", "USD", { priority: 3 }),
  // Financials / Banks
  inst("BRK-B","Berkshire Hathaway", "バークシャー",     "US", "financials", "constituent", "equity", "USD", { priority: 2 }),
  inst("JPM",  "JPMorgan Chase",     "JPモルガン",       "US", "banks", "constituent", "equity", "USD", { priority: 2 }),
  inst("BAC",  "Bank of America",    "バンカメ",         "US", "banks", "constituent", "equity", "USD", { priority: 3 }),
  inst("V",    "Visa",               "ビザ",             "US", "financials", "constituent", "equity", "USD", { priority: 3 }),
  // Health / Biotech
  inst("LLY",  "Eli Lilly",          "イーライリリー",   "US", "health", "constituent", "equity", "USD", { priority: 2 }),
  inst("UNH",  "UnitedHealth",       "ユナイテッドヘルス","US", "health", "constituent", "equity", "USD", { priority: 3 }),
  inst("JNJ",  "Johnson & Johnson",  "J&J",              "US", "health", "constituent", "equity", "USD", { priority: 3 }),
  inst("AMGN", "Amgen",              "アムジェン",       "US", "biotech", "constituent", "equity", "USD", { priority: 4 }),
  // Industrials / Defense
  inst("CAT",  "Caterpillar",        "キャタピラー",     "US", "industrials", "constituent", "equity", "USD", { priority: 3 }),
  inst("GE",   "GE Aerospace",       "GEエアロスペース", "US", "defense", "constituent", "equity", "USD", { priority: 3 }),
  inst("RTX",  "RTX Corp",           "RTX",              "US", "defense", "constituent", "equity", "USD", { priority: 4 }),
  // Materials / Utilities / REIT
  inst("LIN",  "Linde",              "リンデ",           "US", "materials", "constituent", "equity", "USD", { priority: 4 }),
  inst("FCX",  "Freeport-McMoRan",   "フリーポート",     "US", "materials", "constituent", "equity", "USD", { priority: 4 }),
  inst("NEE",  "NextEra Energy",     "ネクステラ",       "US", "utilities", "constituent", "equity", "USD", { priority: 4 }),
  inst("PLD",  "Prologis",           "プロロジス",       "US", "realestate", "constituent", "equity", "USD", { priority: 4 }),
];

/* ---------------- 日本 ---------------- */
const JP_INSTRUMENTS: Instrument[] = [
  inst("1306.T", "NEXT FUNDS TOPIX ETF",        "TOPIX連動",       "JP", "broad", "sector-proxy", "etf", "JPY", { priority: 1 }),
  inst("1615.T", "NEXT FUNDS 銀行業",           "日本 銀行",       "JP", "banks", "sector-proxy", "etf", "JPY", { priority: 2 }),
  inst("1626.T", "NEXT FUNDS 情報通信・サービス","日本 情報通信",   "JP", "tech", "sector-proxy", "etf", "JPY", { priority: 2 }),
  inst("1622.T", "NEXT FUNDS 自動車・輸送機",   "日本 自動車",     "JP", "discretionary", "sector-proxy", "etf", "JPY", { priority: 2 }),
  inst("1625.T", "NEXT FUNDS 電機・精密",       "日本 電機・精密", "JP", "semis", "sector-proxy", "etf", "JPY", { priority: 2 }),
  inst("1617.T", "NEXT FUNDS 食品",             "日本 食品",       "JP", "staples", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1621.T", "NEXT FUNDS 医薬品",           "日本 医薬品",     "JP", "health", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1618.T", "NEXT FUNDS エネルギー資源",   "日本 エネルギー", "JP", "energy", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1620.T", "NEXT FUNDS 素材・化学",       "日本 素材・化学", "JP", "materials", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1628.T", "NEXT FUNDS 不動産",           "日本 不動産",     "JP", "realestate", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1627.T", "NEXT FUNDS 電力・ガス",       "日本 電力・ガス", "JP", "utilities", "sector-proxy", "etf", "JPY", { priority: 3 }),
  inst("1624.T", "NEXT FUNDS 機械",             "日本 機械",       "JP", "industrials", "sector-proxy", "etf", "JPY", { priority: 3 }),

  inst("7203.T", "Toyota Motor",       "トヨタ自動車",     "JP", "discretionary", "constituent", "equity", "JPY", { priority: 1 }),
  inst("6758.T", "Sony Group",         "ソニーグループ",   "JP", "tech", "constituent", "equity", "JPY", { priority: 2 }),
  inst("8306.T", "Mitsubishi UFJ",     "三菱UFJ",          "JP", "banks", "constituent", "equity", "JPY", { priority: 2 }),
  inst("6861.T", "Keyence",            "キーエンス",       "JP", "industrials", "constituent", "equity", "JPY", { priority: 2 }),
  inst("8035.T", "Tokyo Electron",     "東京エレクトロン", "JP", "semis", "constituent", "equity", "JPY", { priority: 2 }),
  inst("9984.T", "SoftBank Group",     "ソフトバンクG",    "JP", "tech", "constituent", "equity", "JPY", { priority: 3 }),
  inst("6501.T", "Hitachi",            "日立製作所",       "JP", "industrials", "constituent", "equity", "JPY", { priority: 3 }),
  inst("4063.T", "Shin-Etsu Chemical", "信越化学",         "JP", "materials", "constituent", "equity", "JPY", { priority: 3 }),
  inst("9432.T", "NTT",                "NTT",              "JP", "communication", "constituent", "equity", "JPY", { priority: 3 }),
  inst("8058.T", "Mitsubishi Corp",    "三菱商事",         "JP", "industrials", "constituent", "equity", "JPY", { priority: 3 }),
  inst("4502.T", "Takeda Pharmaceutical","武田薬品",       "JP", "health", "constituent", "equity", "JPY", { priority: 4 }),
  inst("8766.T", "Tokio Marine",       "東京海上",         "JP", "financials", "constituent", "equity", "JPY", { priority: 4 }),
  inst("6098.T", "Recruit Holdings",   "リクルート",       "JP", "software", "constituent", "equity", "JPY", { priority: 4 }),
  inst("7974.T", "Nintendo",           "任天堂",           "JP", "discretionary", "constituent", "equity", "JPY", { priority: 4 }),
];

/* ---------------- 欧州・英国 ---------------- */
const EU_INSTRUMENTS: Instrument[] = [
  inst("EXV1.DE", "iShares STOXX Europe 600 Banks",       "欧州 銀行",     "EU", "banks", "sector-proxy", "etf", "EUR", { priority: 2 }),
  inst("EXV3.DE", "iShares STOXX Europe 600 Technology",  "欧州 テクノロジー","EU", "tech", "sector-proxy", "etf", "EUR", { priority: 2 }),
  inst("EXV4.DE", "iShares STOXX Europe 600 Health Care", "欧州 ヘルスケア","EU", "health", "sector-proxy", "etf", "EUR", { priority: 2 }),
  inst("EXH1.DE", "iShares STOXX Europe 600 Oil & Gas",   "欧州 石油・ガス","EU", "energy", "sector-proxy", "etf", "EUR", { priority: 3 }),
  inst("EXV6.DE", "iShares STOXX Europe 600 Industrials", "欧州 資本財",   "EU", "industrials", "sector-proxy", "etf", "EUR", { priority: 3 }),
  inst("EXH3.DE", "iShares STOXX Europe 600 Utilities",   "欧州 公益",     "EU", "utilities", "sector-proxy", "etf", "EUR", { priority: 3 }),

  inst("ASML.AS", "ASML Holding",      "ASML",             "EU", "semis", "constituent", "equity", "EUR", { priority: 2 }),
  inst("SAP.DE",  "SAP",               "SAP",              "EU", "software", "constituent", "equity", "EUR", { priority: 2 }),
  inst("SIE.DE",  "Siemens",           "シーメンス",       "EU", "industrials", "constituent", "equity", "EUR", { priority: 3 }),
  inst("MC.PA",   "LVMH",              "LVMH",             "EU", "discretionary", "constituent", "equity", "EUR", { priority: 3 }),
  inst("AIR.PA",  "Airbus",            "エアバス",         "EU", "defense", "constituent", "equity", "EUR", { priority: 4 }),
  inst("OR.PA",   "L'Oreal",           "ロレアル",         "EU", "staples", "constituent", "equity", "EUR", { priority: 4 }),
  inst("AZN.L",   "AstraZeneca",       "アストラゼネカ",   "UK", "health", "constituent", "equity", "GBP", { priority: 3 }),
  inst("SHEL.L",  "Shell",             "シェル",           "UK", "energy", "constituent", "equity", "GBP", { priority: 3 }),
  inst("HSBA.L",  "HSBC Holdings",     "HSBC",             "UK", "banks", "constituent", "equity", "GBP", { priority: 4 }),
  inst("ULVR.L",  "Unilever",          "ユニリーバ",       "UK", "staples", "constituent", "equity", "GBP", { priority: 4 }),
];

/* ---------------- アジア新興 ---------------- */
const ASIA_INSTRUMENTS: Instrument[] = [
  inst("2330.TW",  "TSMC",             "TSMC",             "TW", "semis", "constituent", "equity", "TWD", { priority: 2 }),
  inst("005930.KS","Samsung Electronics","サムスン電子",   "KR", "semis", "constituent", "equity", "KRW", { priority: 2 }),
  inst("0700.HK",  "Tencent Holdings", "テンセント",       "HK", "communication", "constituent", "equity", "HKD", { priority: 3 }),
  inst("9988.HK",  "Alibaba Group",    "アリババ",         "HK", "discretionary", "constituent", "equity", "HKD", { priority: 3 }),
  inst("RELIANCE.NS","Reliance Industries","リライアンス", "IN", "energy", "constituent", "equity", "INR", { priority: 4 }),
  inst("INFY.NS",  "Infosys",          "インフォシス",     "IN", "software", "constituent", "equity", "INR", { priority: 4 }),
  inst("HDFCBANK.NS","HDFC Bank",      "HDFC銀行",         "IN", "banks", "constituent", "equity", "INR", { priority: 4 }),
  inst("EEM",      "iShares MSCI Emerging Markets","新興国株","EM","broad","sector-proxy","etf","USD", { stooq: "eem.us", priority: 3 }),
  inst("EWZ",      "iShares MSCI Brazil","ブラジル株",     "BR", "broad", "sector-proxy", "etf", "USD", { stooq: "ewz.us", priority: 4 }),
  inst("EWA",      "iShares MSCI Australia","豪州株",      "AU", "broad", "sector-proxy", "etf", "USD", { stooq: "ewa.us", priority: 4 }),
  inst("EWC",      "iShares MSCI Canada","カナダ株",       "CA", "broad", "sector-proxy", "etf", "USD", { stooq: "ewc.us", priority: 4 }),
];

/* ---------------- ベンチマーク指数 ---------------- */
const BENCHMARKS: Instrument[] = [
  inst("^GSPC",     "S&P 500",        "S&P 500",        "US", "broad", "benchmark", "index", "USD", { priority: 0 }),
  inst("^IXIC",     "NASDAQ Composite","NASDAQ総合",     "US", "broad", "benchmark", "index", "USD", { priority: 1 }),
  inst("^RUT",      "Russell 2000",   "ラッセル2000",   "US", "broad", "benchmark", "index", "USD", { priority: 2 }),
  inst("^N225",     "Nikkei 225",     "日経平均",       "JP", "broad", "benchmark", "index", "JPY", { priority: 0 }),
  inst("^TOPX",     "TOPIX",          "TOPIX",          "JP", "broad", "benchmark", "index", "JPY", { priority: 2 }),
  inst("^STOXX50E", "EURO STOXX 50",  "ユーロ・ストックス50", "EU", "broad", "benchmark", "index", "EUR", { priority: 1 }),
  inst("^GDAXI",    "DAX",            "DAX",            "EU", "broad", "benchmark", "index", "EUR", { priority: 2 }),
  inst("^FTSE",     "FTSE 100",       "FTSE 100",       "UK", "broad", "benchmark", "index", "GBP", { priority: 2 }),
  inst("^HSI",      "Hang Seng",      "ハンセン",       "HK", "broad", "benchmark", "index", "HKD", { priority: 2 }),
  inst("000001.SS", "Shanghai Composite","上海総合",     "CN", "broad", "benchmark", "index", "CNY", { priority: 2 }),
  inst("^BSESN",    "SENSEX",         "SENSEX",         "IN", "broad", "benchmark", "index", "INR", { priority: 3 }),
  inst("^KS11",     "KOSPI",          "KOSPI",          "KR", "broad", "benchmark", "index", "KRW", { priority: 3 }),
  inst("^TWII",     "TAIEX",          "台湾加権",       "TW", "broad", "benchmark", "index", "TWD", { priority: 3 }),
  inst("^AXJO",     "S&P/ASX 200",    "ASX 200",        "AU", "broad", "benchmark", "index", "AUD", { priority: 4 }),
  inst("^GSPTSE",   "S&P/TSX",        "TSX総合",        "CA", "broad", "benchmark", "index", "CAD", { priority: 4 }),
  inst("^BVSP",     "Bovespa",        "ボベスパ",       "BR", "broad", "benchmark", "index", "BRL", { priority: 4 }),
  inst("ACWI",      "MSCI ACWI ETF",  "全世界株",       "GLOBAL", "broad", "benchmark", "etf", "USD", { stooq: "acwi.us", priority: 3 }),
];

/* ---------------- マクロ (レジーム判定の入力) ---------------- */
const MACRO: Instrument[] = [
  inst("^VIX",       "CBOE Volatility Index", "VIX恐怖指数",   "US", "macro", "macro", "index", "USD", { priority: 0 }),
  inst("^TNX",       "US 10Y Treasury Yield", "米10年金利",    "US", "macro", "macro", "rate", "USD", { priority: 0 }),
  inst("^FVX",       "US 5Y Treasury Yield",  "米5年金利",     "US", "macro", "macro", "rate", "USD", { priority: 3 }),
  inst("DX-Y.NYB",   "US Dollar Index",       "ドル指数",      "US", "macro", "macro", "fx", "USD", { priority: 1 }),
  inst("CL=F",       "WTI Crude Oil",         "WTI原油",       "GLOBAL", "macro", "macro", "commodity", "USD", { priority: 1 }),
  inst("GC=F",       "Gold Futures",          "金先物",        "GLOBAL", "macro", "macro", "commodity", "USD", { priority: 1 }),
  inst("HG=F",       "Copper Futures",        "銅先物",        "GLOBAL", "macro", "macro", "commodity", "USD", { priority: 2 }),
  inst("TLT",        "iShares 20+ Yr Treasury","米長期国債ETF", "US", "macro", "macro", "etf", "USD", { stooq: "tlt.us", priority: 2 }),
  inst("HYG",        "iShares High Yield Corp","ハイイールド債","US", "macro", "macro", "etf", "USD", { stooq: "hyg.us", priority: 2 }),
  inst("LQD",        "iShares Investment Grade","投資適格社債", "US", "macro", "macro", "etf", "USD", { stooq: "lqd.us", priority: 3 }),
  inst("BTC-USD",    "Bitcoin",               "ビットコイン",  "GLOBAL", "crypto", "sector-proxy", "crypto", "USD", { priority: 2 }),
  inst("USDJPY=X",   "USD/JPY",               "ドル円",        "JP", "macro", "macro", "fx", "JPY", { priority: 1 }),
  inst("EURUSD=X",   "EUR/USD",               "ユーロドル",    "EU", "macro", "macro", "fx", "USD", { priority: 3 }),
];

export const UNIVERSE: Instrument[] = [
  ...BENCHMARKS,
  ...MACRO,
  ...US_SECTOR_ETFS,
  ...US_CONSTITUENTS,
  ...JP_INSTRUMENTS,
  ...EU_INSTRUMENTS,
  ...ASIA_INSTRUMENTS,
];

const BY_SYMBOL = new Map(UNIVERSE.map((i) => [i.symbol, i]));

export function getInstrument(symbol: string): Instrument | undefined {
  return BY_SYMBOL.get(symbol);
}

export function instrumentsByRole(role: Instrument["role"]): Instrument[] {
  return UNIVERSE.filter((i) => i.role === role);
}

export function instrumentsInRegion(region: RegionId): Instrument[] {
  return UNIVERSE.filter((i) => i.region === region);
}

/**
 * 地域 × セクターの組み合わせのうち、実際にユニバースに存在するものを返す。
 * ダッシュボードのグリッド生成はここを唯一の真実として使う。
 */
export function sectorCells(): { region: RegionId; sector: SectorId; members: Instrument[] }[] {
  const map = new Map<string, { region: RegionId; sector: SectorId; members: Instrument[] }>();
  for (const i of UNIVERSE) {
    if (i.role === "benchmark" || i.role === "macro") continue;
    const key = `${i.region}/${i.sector}`;
    let cell = map.get(key);
    if (!cell) {
      cell = { region: i.region, sector: i.sector, members: [] };
      map.set(key, cell);
    }
    cell.members.push(i);
  }
  return [...map.values()];
}

/**
 * ユニバースを shard 個に分割し、そのうち index 番目を返す。
 *
 * Workers 無料プランは 1 実行あたりのサブリクエストが 50 本までなので、
 * 全銘柄を毎回取りに行くことはできない。priority 順に安定ソートしてから
 * ラウンドロビンで割ることで、どのシャードにも重要銘柄が混ざるようにする
 * (シャード 7 だけが全部マイナー銘柄、という偏りを避ける)。
 */
export function shardUniverse(index: number, shards: number): Instrument[] {
  const sorted = [...UNIVERSE].sort(
    (a, b) => (a.priority ?? 5) - (b.priority ?? 5) || a.symbol.localeCompare(b.symbol)
  );
  const n = Math.max(1, shards);
  const i = ((index % n) + n) % n;
  return sorted.filter((_, k) => k % n === i);
}
