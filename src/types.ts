/** QAIZ 共通型定義 */

export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  SNAPSHOT_DO: DurableObjectNamespace;
  SENTIMENT_MODEL: string;
  /** 量子OSに割り当てる CPU 予算 (ms)。文字列で入るので数値化して使う */
  QUANTUM_BUDGET_MS?: string;
  /** バスケットの選択本数 */
  BASKET_CARDINALITY?: string;
  /** テールリスク推定の目標精度 */
  TAIL_EPSILON?: string;
  /** 任意の無料APIキー (未設定でも全機能が動作する) */
  FINNHUB_KEY?: string;
  ALPHAVANTAGE_KEY?: string;
  /** 任意: 実機 QPU (未設定ならシミュレータのみで動作する) */
  QPU_ENDPOINT?: string;
  QPU_TOKEN?: string;
  QPU_BACKEND?: string;
}

/** 日次バー (終値ベース) */
export interface Bar {
  t: number; // unix seconds
  c: number; // close
}

/** 1銘柄分の時系列 */
export interface Series {
  symbol: string;
  name: string;
  bars: Bar[];
  source: "yahoo" | "stooq";
}

/** セクター定義 */
export interface SectorDef {
  id: string;
  nameJa: string;
  nameEn: string;
  /** 代表ETF/指数 (Yahoo Finance シンボル) */
  symbol: string;
  /** Stooq フォールバック用シンボル */
  stooqSymbol?: string;
  /** ニュース検索キーワード */
  keywords: string[];
}

/** 量子情報幾何の指標群 */
export interface QuantumGeometry {
  /** 直近窓と過去窓の量子忠実度 F = |<ψ1|ψ2>|^2 (1に近い=レジーム安定) */
  fidelity: number;
  /** Fubini-Study 距離 arccos(√F) ∈ [0, π/2] (大=レジーム転換の兆候) */
  fubiniStudy: number;
  /** 量子Fisher情報の古典近似 (リターン分布の情報量=市場の感応度) */
  qfiProxy: number;
  /** シャノンエントロピー (リターン振幅分布の不確実性) */
  entropy: number;
}

/** 宇宙論的スペクトル指標群 */
export interface CosmoSpectral {
  /** Hurst 指数 (0.5=ランダムウォーク, >0.5=トレンド持続, <0.5=平均回帰) */
  hurst: number;
  /** パワースペクトルの傾き (CMB解析のアナロジー: 赤いほど長期トレンド優勢) */
  spectralSlope: number;
}

/** モメンタム指標群 */
export interface Momentum {
  r1w: number;  // 1週間リターン
  r1m: number;  // 1ヶ月リターン
  r3m: number;  // 3ヶ月リターン
  volAdj: number; // ボラティリティ調整済みモメンタム (シャープ比風)
  trendConsistency: number; // 上昇日比率 [0,1]
}

export interface SectorScore {
  sector: SectorDef;
  momentum: Momentum;
  quantum: QuantumGeometry;
  cosmo: CosmoSpectral;
  sentiment: SentimentResult | null;
  /** 総合ヒートスコア [0,100] */
  heat: number;
  lastClose: number;
  spark: number[]; // 直近60営業日の正規化終値 (ダッシュボード用)
}

export interface SentimentResult {
  score: number; // [-1, 1]
  label: "bullish" | "bearish" | "neutral";
  headlineCount: number;
  method: "workers-ai" | "lexicon";
}

export interface NewsItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
}

export interface GlobalIndexQuote {
  symbol: string;
  name: string;
  region: string;
  lastClose: number;
  r1d: number;
  r1w: number;
  r1m: number;
}

/**
 * 量子OSが毎時解く「決定」の出力。
 * ランキングを出すだけだった QAIZ に、実際の建玉候補とその尾リスクを持たせる。
 */
export interface QuantumDecision {
  /** 選ばれたセクター (基数制約付き平均分散最適化の解) */
  basket: {
    ids: string[];
    cardinality: number;
    riskAversion: number;
    expectedReturn: number;
    variance: number;
    objective: number;
    feasible: boolean;
    /** 厳密解と一致したか (厳密解が取れた場合のみ) */
    matchesExact: boolean | null;
  };
  /** 選ばれたバスケットのテールリスク */
  risk: {
    varThreshold: number;
    cvar: number;
    tailProbability: number;
    quantumEstimate: number;
    epsilon: number;
    oracleCalls: number;
    classicalSamples: number;
    queryAdvantage: number;
    qubits: number;
  };
  /** バックエンド横並びの実測ログ */
  ledgerEntries: LedgerEntrySummary[];
  /** 厳密列挙が 10⁹ 候補を超える資産数 = 量子の出番が始まりうる境界 */
  exactEnumerationWallAt: number;
  budgetMs: number;
}

/** ダッシュボード/API に載せる台帳エントリの縮約形 */
export interface LedgerEntrySummary {
  ts: string;
  problem: string;
  size: number;
  verdict: { kind: string; reason?: string; factor?: number; note?: string };
  summary: string;
  runs: {
    backend: string;
    kind: string;
    wallMs: number;
    queries: number;
    ok: boolean;
    error?: string;
  }[];
  approximationRatio?: number;
}

/** cron パイプラインが Durable Object に保存するスナップショット全体 */
export interface Snapshot {
  generatedAt: string;
  sectors: SectorScore[];
  indices: GlobalIndexQuote[];
  news: NewsItem[];
  /** 量子OSの出力 (計算が間に合わなかった場合は null) */
  quantum: QuantumDecision | null;
  meta: {
    version: string;
    dataSources: string[];
    aiModel: string;
    errors: string[];
  };
}
