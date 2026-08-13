/**
 * QAIZ — Quantitative Analyst Intelligence Zone
 * 共通型定義。
 *
 * 設計方針:
 *  - 「取れなかった値」は 0 ではなく null にする。0 は「PER が 0 倍」という
 *    意味のある値なので、欠損と混ぜた瞬間にランキングが壊れる。
 *  - 数値には必ず出所 (source) と基準時刻 (asOf) を添える。出所の書いていない
 *    ファンダメンタルズは検証できない = 分析に使ってはいけない。
 */

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  STORE: DurableObjectNamespace;
  SENTIMENT_MODEL: string;
  /** 1 回の cron 実行で回すユニバースの分割数 (サブリクエスト上限対策) */
  SHARDS?: string;
  /** 1 実行あたりの外部フェッチ上限 */
  FETCH_BUDGET?: string;
  /** ファクター合成ウェイト (JSON)。未設定ならデフォルト */
  FACTOR_WEIGHTS?: string;
  /** 任意の無料APIキー (未設定でも全機能が動作する) */
  FINNHUB_KEY?: string;
  FMP_KEY?: string;
}

/* ------------------------------------------------------------------ */
/* ユニバース                                                          */
/* ------------------------------------------------------------------ */

export type AssetClass =
  | "etf"
  | "equity"
  | "index"
  | "commodity"
  | "crypto"
  | "fx"
  | "rate";

export type RegionId =
  | "US"
  | "JP"
  | "EU"
  | "UK"
  | "CN"
  | "HK"
  | "IN"
  | "KR"
  | "TW"
  | "AU"
  | "CA"
  | "BR"
  | "EM"
  | "GLOBAL";

/** GICS 11 セクター + 実務でよく切り出される派生バケット */
export type SectorId =
  | "tech"
  | "semis"
  | "software"
  | "communication"
  | "discretionary"
  | "staples"
  | "energy"
  | "financials"
  | "banks"
  | "health"
  | "biotech"
  | "industrials"
  | "defense"
  | "materials"
  | "utilities"
  | "realestate"
  | "gold"
  | "crypto"
  | "broad"
  | "macro";

export type InstrumentRole =
  | "sector-proxy"
  | "constituent"
  | "benchmark"
  | "macro";

export interface Instrument {
  /** Yahoo Finance シンボル (一次キー) */
  symbol: string;
  name: string;
  nameJa: string;
  region: RegionId;
  sector: SectorId;
  assetClass: AssetClass;
  role: InstrumentRole;
  /** 表示通貨 (為替換算はしない。比較は必ずリターン基準で行う) */
  currency: string;
  /** Stooq フォールバック用シンボル */
  stooq?: string;
  /** ニュース検索キーワード */
  keywords?: string[];
  /** ファンダメンタルズ取得の優先度 (低いほど先に取る) */
  priority?: number;
}

/* ------------------------------------------------------------------ */
/* 価格データ                                                          */
/* ------------------------------------------------------------------ */

/** 日次 OHLCV バー */
export interface Bar {
  /** unix seconds */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** 出来高。指数など取れない銘柄は null */
  v: number | null;
}

export interface Series {
  symbol: string;
  name: string;
  currency: string;
  bars: Bar[];
  source: "yahoo" | "stooq";
  fetchedAt: string;
}

export interface PriceSummary {
  last: number;
  previousClose: number | null;
  /** 各期間の単純リターン (小数。0.031 = +3.1%) */
  r1d: number | null;
  r1w: number | null;
  r1m: number | null;
  r3m: number | null;
  r6m: number | null;
  r12m: number | null;
  ytd: number | null;
  /** 12-1 モメンタム: 直近 1 ヶ月を除いた 12 ヶ月リターン (反転効果の除去) */
  r12m1m: number | null;
  high52w: number | null;
  low52w: number | null;
  /** 52 週レンジ内の位置 [0,1]。1 = 年初来高値 */
  rangePosition52w: number | null;
  /** 52 週高値からの下落率 (負値) */
  drawdownFrom52wHigh: number | null;
  avgVolume20d: number | null;
  volumeRatio: number | null;
  currency: string;
}

/* ------------------------------------------------------------------ */
/* テクニカル                                                          */
/* ------------------------------------------------------------------ */

export interface MovingAverages {
  sma5: number | null;
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
  ema12: number | null;
  ema26: number | null;
  /** 終値が各線の上にあるか (null = 線が計算できない) */
  above: { sma20: boolean | null; sma50: boolean | null; sma200: boolean | null };
  /** 終値の 200 日線からの乖離率 */
  deviation200: number | null;
  /** 50 日線と 200 日線の関係 */
  cross: "golden" | "dead" | "none";
  /** 直近でクロスしてからの営業日数 (クロスが窓内に無ければ null) */
  crossAgeDays: number | null;
  /** 短期→長期に整列しているか (パーフェクトオーダー) */
  perfectOrder: "bullish" | "bearish" | "none";
}

export interface Macd {
  macd: number;
  signal: number;
  histogram: number;
  /** ヒストグラムの符号反転が起きた営業日数前 (無ければ null) */
  crossAgeDays: number | null;
  state: "bullish" | "bearish";
}

export interface Bollinger {
  middle: number;
  upper: number;
  lower: number;
  /** %B = (price - lower) / (upper - lower)。1 超で上バンド突破 */
  percentB: number;
  /** バンド幅 / 中心線。スクイーズ判定に使う */
  bandwidth: number;
  /** 直近 120 日のバンド幅パーセンタイル。低い = スクイーズ */
  bandwidthPercentile: number | null;
  squeeze: boolean;
}

export interface Stochastic {
  k: number;
  d: number;
  state: "overbought" | "oversold" | "neutral";
}

export interface Adx {
  adx: number;
  plusDi: number;
  minusDi: number;
  /** ADX > 25 でトレンド、< 20 でレンジ */
  regime: "trending" | "ranging" | "transitional";
  direction: "up" | "down";
}

export interface PivotLevels {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
  method: "classic" | "fibonacci";
}

export interface SupportResistance {
  /** 直近終値より上にある抵抗帯 (近い順) */
  resistance: { level: number; touches: number; distancePct: number }[];
  /** 直近終値より下にある支持帯 (近い順) */
  support: { level: number; touches: number; distancePct: number }[];
}

export interface Technicals {
  rsi14: number | null;
  rsi14State: "overbought" | "oversold" | "neutral" | null;
  /** RSI のダイバージェンス検出 */
  rsiDivergence: "bullish" | "bearish" | "none";
  ma: MovingAverages;
  macd: Macd | null;
  bollinger: Bollinger | null;
  atr14: number | null;
  /** ATR / 終値。ボラティリティの実務的な単位 */
  atrPercent: number | null;
  stochastic: Stochastic | null;
  adx: Adx | null;
  /** On-Balance Volume の 20 日勾配 (正規化済み) */
  obvSlope20: number | null;
  mfi14: number | null;
  cci20: number | null;
  williamsR14: number | null;
  roc20: number | null;
  /** 出来高加重平均価格 (20 日) と現値の乖離 */
  vwap20: number | null;
  vwapDeviation: number | null;
  pivots: PivotLevels | null;
  fibPivots: PivotLevels | null;
  levels: SupportResistance;
  /** 直近 20 日の上昇日比率 */
  upDayRatio20: number | null;
  /** テクニカル総合 [0,100]。個別指標の合議 */
  compositeScore: number;
  compositeLabel: "strong-buy" | "buy" | "neutral" | "sell" | "strong-sell";
  /** 合議の内訳。何が効いて何が効いていないかを開示する */
  breakdown: { indicator: string; verdict: "bull" | "bear" | "flat"; note: string }[];
}

/* ------------------------------------------------------------------ */
/* リスク                                                              */
/* ------------------------------------------------------------------ */

export interface RiskMetrics {
  /** 年率ボラティリティ (窓別) */
  vol20: number | null;
  vol60: number | null;
  vol252: number | null;
  /** ボラの方向: vol20 / vol252 */
  volRatio: number | null;
  downsideDeviation: number | null;
  /** ベンチマークに対する回帰 */
  beta: number | null;
  alphaAnnual: number | null;
  rSquared: number | null;
  correlationToBenchmark: number | null;
  trackingError: number | null;
  informationRatio: number | null;
  upCapture: number | null;
  downCapture: number | null;
  /** 最大ドローダウン (負値) と発生・回復 */
  maxDrawdown: number | null;
  maxDrawdownDays: number | null;
  currentDrawdown: number | null;
  /** リスク調整後リターン (年率, 無リスク金利 0 前提を明示) */
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  /** 歴史的 VaR / CVaR (日次, 正の値で「この%失う」) */
  var95: number | null;
  var99: number | null;
  cvar95: number | null;
  cvar99: number | null;
  skewness: number | null;
  kurtosis: number | null;
  /** 直近 1 年で日次 ±2σ を超えた日数 */
  tailDays: number | null;
  benchmark: string | null;
  riskFreeAssumption: string;
}

/* ------------------------------------------------------------------ */
/* ファンダメンタルズ                                                   */
/* ------------------------------------------------------------------ */

export interface Fundamentals {
  symbol: string;
  asOf: string;
  source: string;
  currency: string | null;

  marketCap: number | null;
  enterpriseValue: number | null;
  sharesOutstanding: number | null;
  floatShares: number | null;

  /* バリュエーション */
  trailingPE: number | null;
  forwardPE: number | null;
  pegRatio: number | null;
  priceToBook: number | null;
  priceToSales: number | null;
  evToEbitda: number | null;
  evToSales: number | null;
  evToFcf: number | null;
  earningsYield: number | null;
  fcfYield: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  buybackYield: number | null;

  /* 収益性 */
  returnOnEquity: number | null;
  returnOnAssets: number | null;
  returnOnInvestedCapital: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  profitMargin: number | null;
  ebitdaMargin: number | null;

  /* 財務健全性 */
  debtToEquity: number | null;
  netDebtToEbitda: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  interestCoverage: number | null;
  totalCash: number | null;
  totalDebt: number | null;

  /* 成長 */
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  earningsQuarterlyGrowth: number | null;
  revenue3yCagr: number | null;

  /* 需給・その他 */
  beta: number | null;
  shortPercentOfFloat: number | null;
  heldPercentInstitutions: number | null;
  heldPercentInsiders: number | null;

  /* 1 株あたり */
  trailingEps: number | null;
  forwardEps: number | null;
  bookValuePerShare: number | null;
  revenuePerShare: number | null;

  /* 派生指標の計算に使う絶対額。UI には出さないが、
     EV/FCF や ROIC の再現に必要なので同じオブジェクトで運ぶ */
  revenueValue: number | null;
  ebitdaValue: number | null;
  ebitValue: number | null;
  freeCashflowValue: number | null;
  operatingCashflowValue: number | null;
  totalEquityValue: number | null;
  interestExpenseValue: number | null;

  /** どのフィールドがどこから来たか。null 埋めと実測を区別する */
  fieldSources: Record<string, string>;
}

/** アナリスト・コンセンサス */
export interface Consensus {
  symbol: string;
  asOf: string;
  source: string;
  /** 1=Strong Buy … 5=Strong Sell (Yahoo 準拠) */
  recommendationMean: number | null;
  recommendationKey: string | null;
  analystCount: number | null;
  targetMean: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  targetMedian: number | null;
  /** 目標株価までの上値余地 */
  upsideToTarget: number | null;
  /** 目標株価のばらつき (high-low)/mean。大きい = 見方が割れている */
  targetDispersion: number | null;
  /** レーティング分布の時系列 (0m = 今月, -1m = 先月 …) */
  trend: {
    period: string;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  }[];
  /** 直近 3 ヶ月でレーティングが強気化したか */
  ratingMomentum: number | null;
  /** EPS 予想の改定方向 */
  epsRevision: { period: string; up: number; down: number } | null;
}

/* ------------------------------------------------------------------ */
/* スコアカード                                                        */
/* ------------------------------------------------------------------ */

/** 指標 1 本の評価。生値・偏差値・順位を必ずセットで持つ */
export interface MetricScore {
  key: string;
  label: string;
  value: number | null;
  /** 同一ピア群でのZスコア (方向補正済み: 高いほど良い) */
  z: number | null;
  /** 同一ピア群でのパーセンタイル [0,100] (高いほど良い) */
  percentile: number | null;
  /** ピア群の中央値 */
  peerMedian: number | null;
  /** 値が小さいほど良い指標か */
  lowerIsBetter: boolean;
  unit: "x" | "%" | "ratio" | "abs" | "score";
}

export interface Scorecard {
  /** 0-100。ピア群内の相対評価 */
  score: number | null;
  metrics: MetricScore[];
  /** 評価に使えた指標数 / 全指標数。低いとスコアの信頼性が落ちる */
  coverage: number;
}

/** 5 ファクターの合成 */
export interface FactorScores {
  value: number | null;
  quality: number | null;
  momentum: number | null;
  growth: number | null;
  lowVol: number | null;
  /** 加重合成 [0,100] */
  composite: number | null;
  /**
   * 合成に使えたウェイトの割合 [0,1]。
   * ETF や指数はファンダメンタルズが存在しないので勢い・低ボラだけで
   * 0.35 前後になる。個別株の 1.0 と同じ土俵で比べていないことが
   * 一目で分かるように、スコアと必ずセットで持たせる。
   */
  coverage: number;
  /** ピア群内の順位 */
  rank: number | null;
  peerCount: number;
  /** どのファクターが合成を押し上げ/押し下げたか */
  contributions: { factor: string; weight: number; z: number | null; contribution: number }[];
}

/* ------------------------------------------------------------------ */
/* シグナル                                                            */
/* ------------------------------------------------------------------ */

export interface Signal {
  id: string;
  category: "technical" | "valuation" | "quality" | "momentum" | "risk" | "consensus";
  direction: "bullish" | "bearish" | "caution";
  strength: 1 | 2 | 3;
  title: string;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* 集計・市場全体                                                      */
/* ------------------------------------------------------------------ */

/** 相対ローテーショングラフ (RRG) の座標 */
export interface RotationPoint {
  symbol: string;
  name: string;
  sector: SectorId;
  region: RegionId;
  /** 相対力 (100 中心) */
  rsRatio: number;
  /** 相対力のモメンタム (100 中心) */
  rsMomentum: number;
  quadrant: "leading" | "weakening" | "lagging" | "improving";
  /** 過去 5 週分の軌跡 (古い→新しい) */
  trail: { rsRatio: number; rsMomentum: number }[];
}

/** 市場の幅 */
export interface Breadth {
  scope: string;
  count: number;
  pctAbove50dma: number | null;
  pctAbove200dma: number | null;
  advancers: number;
  decliners: number;
  advanceDeclineRatio: number | null;
  newHighs52w: number;
  newLows52w: number;
  /** 平均 RSI */
  meanRsi: number | null;
  /** 上昇銘柄比率から見た過熱/過冷 */
  label: "broad-rally" | "narrow-rally" | "mixed" | "broad-selloff" | "narrow-selloff";
}

/** 相場レジーム判定 */
export interface Regime {
  asOf: string;
  /** トレンド/レンジ */
  trend: "bull" | "bear" | "range";
  trendConfidence: number;
  /** ボラティリティ環境 */
  volatility: "low" | "normal" | "elevated" | "stress";
  /** リスクオン / リスクオフ */
  riskAppetite: "risk-on" | "neutral" | "risk-off";
  /** 判定の根拠 (どの観測値がどう効いたか) */
  evidence: { name: string; value: number | null; reading: string }[];
  /** レジームに応じた戦術メモ */
  playbook: string[];
}

/** 相関・分散構造 */
export interface CorrelationBlock {
  symbols: string[];
  labels: string[];
  /** 行優先の相関行列 */
  matrix: number[];
  window: number;
  /** 平均ペア相関。高い = 分散が効かない相場 */
  meanPairwise: number;
  /** 第1主成分の寄与率 = 市場一体化度 */
  pc1Share: number;
  /** 第1主成分のローディング */
  pc1Loadings: number[];
  /** 相関距離によるクラスタ (階層クラスタリングの平坦化) */
  clusters: { id: number; symbols: string[] }[];
}

/* ------------------------------------------------------------------ */
/* レコード & スナップショット                                          */
/* ------------------------------------------------------------------ */

/** 1 銘柄の全分析結果 */
export interface InstrumentRecord {
  instrument: Instrument;
  asOf: string;
  price: PriceSummary;
  technicals: Technicals;
  risk: RiskMetrics;
  fundamentals: Fundamentals | null;
  consensus: Consensus | null;
  valuation: Scorecard | null;
  quality: Scorecard | null;
  growth: Scorecard | null;
  factors: FactorScores | null;
  signals: Signal[];
  /** 直近 120 営業日の終値 (ダッシュボードのスパークライン用) */
  spark: number[];
  dataQuality: {
    bars: number;
    priceSource: string;
    fundamentalsSource: string | null;
    /** 価格データの最終営業日 */
    lastBarDate: string;
    /** 取得時に起きた問題 */
    warnings: string[];
  };
}

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

export interface SentimentResult {
  score: number;
  label: "bullish" | "bearish" | "neutral";
  headlineCount: number;
  method: "workers-ai" | "lexicon";
}

/**
 * ニュース概況の要約。
 *
 * 見出しの羅列は「何が起きたか」しか伝えない。要るのは「何がどうなっていて、
 * どこに効くのか」なので、テーマ単位に束ねて影響先セクターまで書き下す。
 *
 * AI が使えなかった場合も必ず値を返す (method で見分けられるようにする)。
 * 生成物と機械集計を同じ見た目で出すと、読み手が信頼度を測れなくなる。
 */
export interface NewsTheme {
  title: string;
  detail: string;
  impact: "bullish" | "bearish" | "mixed";
  /** 影響先セクター (SectorId。未知の文字列は捨てる) */
  sectors: SectorId[];
  /** このテーマの根拠になった見出し数 */
  headlineCount: number;
}

export interface NewsBrief {
  asOf: string;
  method: "workers-ai" | "rule-based";
  /** 生成に使ったモデル (rule-based のときは null) */
  model: string | null;
  /** 一行で今の相場 */
  headline: string;
  /** 「何がどうなっているか」の本文 (3-5 行) */
  summary: string[];
  themes: NewsTheme[];
  /** 次に効きそうな材料 */
  watch: string[];
  /** 要約の入力になった見出し数とフィード数 */
  headlineCount: number;
  sourceCount: number;
  /** AI を使えなかった理由 (使えた場合は null)。黙って劣化させない */
  degradedReason: string | null;
}

/* ------------------------------------------------------------------ */
/* セクター見通し (先行き)                                              */
/* ------------------------------------------------------------------ */

/**
 * 見通しスコアを構成する「柱」1 本。
 *
 * 合成スコアだけ出すのは占いと変わらない。どの観測値が、どの向きに、
 * どれだけ効いたかを必ず開示する。読み手が柱ごとに反論できる形が最低条件。
 */
export interface OutlookPillar {
  key: string;
  label: string;
  /** 設計上のウェイト (合計は正規化される) */
  weight: number;
  /**
   * 方向補正済みのシグナル値 (Zスコア単位, 正 = 上昇寄り)。
   * データが無くて評価できない柱は null。
   */
  z: number | null;
  /** 合成への寄与 = z × 正規化ウェイト */
  contribution: number;
  /** cross-sectional に標準化した柱か (false = 絶対水準で決まる柱) */
  standardized: boolean;
  /** 人間が読むための一行 */
  reading: string;
  /** この柱に入れた生の観測値 */
  inputs: { name: string; value: number | null; unit: "%" | "x" | "score" | "z" | "abs" }[];
}

export interface SectorOutlook {
  region: RegionId;
  sector: SectorId;
  nameJa: string;
  nameEn: string;
  proxySymbol: string | null;
  memberCount: number;

  /** 合成シグナル (Zスコア単位)。正 = 上昇寄り */
  z: number;
  /** 0-100 に写したもの。順位の読みやすさ用であって、確率ではない */
  score: number;
  direction: "up" | "down" | "neutral";
  /** 想定する時間軸 */
  horizon: string;

  /** 柱の符号一致率 [0,1]。低い = 材料が割れている */
  agreement: number;
  /** 評価できた柱のウェイト比率 [0,1] */
  coverage: number;
  /** 一致率・被覆・シグナルの強さから作る確信度 [0,100] */
  conviction: number;

  /** ランキング上の順位 (1 = 最も上がりやすい) */
  rank: number;
  rankOf: number;

  pillars: OutlookPillar[];
  /** 押し上げている材料 (寄与の大きい順) */
  drivers: string[];
  /** 押し下げている材料 / リスク */
  risks: string[];
  /** 一行の論拠 */
  thesis: string;
  /** これが起きたら見立ては外れ、と事前に決めておく条件 */
  invalidation: string;
  /** ATR から見た 1 ヶ月の想定変動幅 (±, 小数)。方向の予測ではない */
  expectedMove1m: number | null;
  sentiment: SentimentResult | null;
  /** 根拠になった見出し */
  headlines: string[];
}

/**
 * 順位表の 1 行。
 *
 * 全セクター分の柱の内訳まで保存すると Durable Object の 1 値あたりの
 * 上限 (128 KiB) に当たるので、一覧はこの軽い形にし、内訳は上位・下位の
 * 推薦銘柄にだけ持たせる。
 */
export interface SectorOutlookRow {
  region: RegionId;
  sector: SectorId;
  nameJa: string;
  proxySymbol: string | null;
  memberCount: number;
  z: number;
  score: number;
  direction: "up" | "down" | "neutral";
  conviction: number;
  coverage: number;
  agreement: number;
  rank: number;
  /** 最も効いている柱と、最も逆風の柱 (ラベルのみ) */
  topDriver: string | null;
  topRisk: string | null;
}

export interface OutlookBoard {
  asOf: string;
  horizon: string;
  /** 上がりやすい順の上位 (柱の内訳つき) */
  bullish: SectorOutlook[];
  /** 下がりやすい順の上位 (柱の内訳つき) */
  bearish: SectorOutlook[];
  /** 全セクターのスコア (順位順、軽量版) */
  all: SectorOutlookRow[];
  /** 手法の説明。スコアの意味を取り違えられないように必ず添える */
  method: string;
  /** 柱のウェイト定義 */
  weights: { key: string; label: string; weight: number; rationale: string }[];
}

/** セクター集計 (地域 × セクター) */
export interface SectorAggregate {
  region: RegionId;
  sector: SectorId;
  nameJa: string;
  nameEn: string;
  /** 代表銘柄 (ETF) */
  proxySymbol: string | null;
  memberCount: number;
  /** 代表 ETF のリターン。無ければ構成銘柄の中央値 */
  r1w: number | null;
  r1m: number | null;
  r3m: number | null;
  r12m: number | null;
  /** 構成銘柄の中央値バリュエーション */
  medianPE: number | null;
  medianForwardPE: number | null;
  medianPB: number | null;
  medianEvEbitda: number | null;
  medianDividendYield: number | null;
  medianROE: number | null;
  medianRevenueGrowth: number | null;
  /** 構成銘柄の平均テクニカルスコア */
  meanTechnical: number | null;
  meanRsi: number | null;
  pctAbove200dma: number | null;
  /** ファクター合成の中央値 */
  medianComposite: number | null;
  sentiment: SentimentResult | null;
  /** ランキング用の総合ヒート [0,100] */
  heat: number | null;
  spark: number[];
}

export interface Snapshot {
  generatedAt: string;
  version: string;
  /** シンボル -> レコード */
  records: Record<string, InstrumentRecord>;
  sectors: SectorAggregate[];
  rotation: RotationPoint[];
  breadth: Breadth[];
  regime: Regime | null;
  correlation: CorrelationBlock | null;
  news: NewsItem[];
  /** ニュースの AI 要約 (生成できなければ機械集計版が入る) */
  newsBrief: NewsBrief | null;
  /** セクター先行き見通しランキング */
  outlook: OutlookBoard | null;
  meta: {
    universeSize: number;
    covered: number;
    shard: number;
    shards: number;
    fetches: number;
    aiModel: string;
    dataSources: string[];
    /** 直近の更新にかかった時間 */
    elapsedMs: number;
    errors: string[];
  };
}
