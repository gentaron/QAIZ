import type {
  InstrumentRecord,
  NewsItem,
  OutlookBoard,
  OutlookPillar,
  Regime,
  RegionId,
  RotationPoint,
  SectorAggregate,
  SectorOutlook,
  SectorOutlookRow,
} from "../types.ts";
import { REGION_META, SECTOR_CYCLICALITY, SECTOR_META } from "../config/sectors.ts";
import { sectorCells } from "../config/universe.ts";
// matchHeadlines は見出しのキーワード一致だけを行う純関数 (Env にも
// ネットワークにも触らない)。同じ照合を書き写すほうが害が大きいので
// ai/ から借りている。分析層が AI を呼ぶわけではない。
import { matchHeadlines } from "../ai/sentiment.ts";
import { clamp, isNum, mean, median, round, zscores, zToScore } from "./stats.ts";

/**
 * セクター先行き見通し (これから上がりそう / 下がりそう) のランキング。
 *
 * ■ この実装が依拠している考え方
 *
 * 「上がる銘柄を当てる」ではなく、**過去に持続性が確認されている効果を
 * 複数並べ、互いに独立な証拠として重み付けで足す** という組み方をしている。
 * 単一指標のランキング (リターン順、PER順) は、その指標が効かない局面で
 * 丸ごと外れる。複数の柱に分けておけば、外れたときにどの柱が間違ったかを
 * 事後に特定できる。
 *
 * 採用した柱と、その根拠:
 *
 *  1. 絶対トレンド (時系列モメンタム)
 *     自分自身の過去リターンが将来リターンと正の関係を持つ現象。
 *     Moskowitz-Ooi-Pedersen (2012) "Time Series Momentum"。
 *     直近 1 ヶ月を除いた 12 ヶ月 (12-1) を使うのは、直近 1 ヶ月に
 *     反転効果が混ざるため (Jegadeesh-Titman 1993 の標準的な作法)。
 *
 *  2. 相対力 (業種モメンタム)
 *     Moskowitz-Grinblatt (1999) は、個別株モメンタムの相当部分が
 *     **業種単位** のモメンタムで説明できることを示した。セクター選択に
 *     おいては個別株より素直に効く。
 *
 *  3. 相対力の加速 (RS モメンタム)
 *     水準ではなく変化率。順位が入れ替わる局面を、水準が入れ替わる前に拾う。
 *     RRG (相対ローテーション) の縦軸と同じ量。
 *
 *  4. 短期リバーサル
 *     1 週〜1 ヶ月の直近リターンは翌月に反転しやすい (Jegadeesh 1990)。
 *     2・3 と符号が逆になるので、意図的に弱いウェイトで**逆張り側**に置く。
 *
 *  5. 参加の幅 (ブレッドス)
 *     同じ上昇でも、構成銘柄の広い参加を伴う上昇のほうが持続する。
 *     代表 ETF だけ上がって中身が付いてきていない上昇を減点するための柱。
 *
 *  6. 業績改定ドリフト
 *     アナリスト予想の改定方向は、改定後もしばらく同じ向きに効き続ける
 *     (post-earnings/revision drift)。ファンダ側では最も短期に効く材料。
 *
 *  7. バリュエーション (逆張り)
 *     割安さは 1-3 ヶ月ではほとんど効かないが、長い目では効く。
 *     「効かない期間がある」ことを承知の上で、軽いウェイトで入れる。
 *
 *  8. 質・成長
 *     収益性の高さは長期のリターン差を説明する (Novy-Marx 2013)。
 *     これも短期の効き目は弱いので軽い。
 *
 *  9. リスク (ボラの拡大・ドローダウン)
 *     ボラティリティはクラスタリングする。拡大中のセクターは
 *     リスク調整後で不利になりやすい。
 *
 * 10. ニュースセンチメント
 *     AI が読んだ見出しの強弱。ノイズが多いので最軽量。
 *
 * 11. レジーム整合 (景気敏感度 × 相場地形)
 *     リスクオン局面ではシクリカル、リスクオフではディフェンシブ。
 *     横断標準化ではなく、地形から直接決まる**絶対の傾き**として入れる。
 *
 * 12. 平均回帰 (過熱 / 押し目)
 *     RSI と 200 日線乖離が極端な領域に入ったときだけ効かせる非線形項。
 *     線形の Z にするとモメンタムの柱と単純に打ち消し合ってしまうため、
 *     閾値を超えた分だけをペナルティ / ボーナスにしている。
 *
 * 13. 市場の地合い (地域)
 *     セクターの評価は地域内の相対で作る (通貨と市場水準の差を落とすため)。
 *     地域をまたいで並べるときは、その地域自体の強弱を別の柱として足す。
 *
 * ■ スコアの意味
 *
 * score は「上がる確率」ではない。同じ土俵に並べたときの**相対的な
 * 有利さの順位**である。確率として読ませないために direction と
 * conviction (確信度) を必ず併記し、想定変動幅は ATR から別に出す。
 */

/** 想定する時間軸。柱のウェイトはこの horizon を前提に決めてある */
export const OUTLOOK_HORIZON = "1〜3ヶ月";

type PoolKey = string;

interface Part {
  name: string;
  unit: OutlookPillar["inputs"][number]["unit"];
  /** +1 = 大きいほど上昇寄り, -1 = 小さいほど上昇寄り */
  dir: 1 | -1;
  value: number | null;
}

interface PillarDef {
  key: string;
  label: string;
  weight: number;
  rationale: string;
  /** cross-sectional に標準化するか */
  standardized: boolean;
  parts: (f: CellFeatures) => Part[];
  /** standardized:false の柱はここで直接 Z 単位の値を作る */
  direct?: (f: CellFeatures) => { z: number | null; reading: string };
  reading: (f: CellFeatures, z: number | null) => string;
}

/* ------------------------------------------------------------------ */
/* セクター 1 セルの生の観測値                                          */
/* ------------------------------------------------------------------ */

interface CellFeatures {
  agg: SectorAggregate;
  region: RegionId;
  poolKey: PoolKey;
  proxy: InstrumentRecord | null;
  members: InstrumentRecord[];
  rotation: RotationPoint | null;
  benchmark: InstrumentRecord | null;

  /* トレンド */
  r12m1m: number | null;
  r6m: number | null;
  /* 相対 */
  rsRatio: number | null;
  rsMomentum: number | null;
  excess3m: number | null;
  excess1m: number | null;
  /** 相対力の加速: 直近 1 ヶ月の超過を 3 ヶ月平均ペースと比べた差 */
  excessAccel: number | null;
  /* 短期 */
  r1w: number | null;
  r1m: number | null;
  /* 幅 */
  pctAbove200dma: number | null;
  pctAbove50dma: number | null;
  /* 改定 */
  ratingMomentum: number | null;
  epsRevisionNet: number | null;
  upsideToTarget: number | null;
  /* バリュエーション */
  forwardEarningsYield: number | null;
  priceToBook: number | null;
  /* 質・成長 */
  roe: number | null;
  revenueGrowth: number | null;
  /* リスク */
  volRatio: number | null;
  currentDrawdown: number | null;
  /* 過熱 */
  rsi: number | null;
  deviation200: number | null;
  /* その他 */
  sentimentScore: number | null;
  atrPercent: number | null;
  regionZ: number | null;
  cyclicality: "cyclical" | "defensive" | "neutral";
  regime: Regime | null;
}

const num = (xs: (number | null | undefined)[]): number | null =>
  median(xs.filter(isNum));

function ratioTrue(xs: (boolean | null)[]): number | null {
  const known = xs.filter((x): x is boolean => x !== null);
  return known.length > 0 ? known.filter(Boolean).length / known.length : null;
}

/** アナリストの EPS 改定の正味方向 [-1, 1] */
function epsRevisionNet(r: InstrumentRecord): number | null {
  const rev = r.consensus?.epsRevision;
  if (!rev) return null;
  const total = rev.up + rev.down;
  return total > 0 ? (rev.up - rev.down) / total : null;
}

/* ------------------------------------------------------------------ */
/* 柱の定義                                                            */
/* ------------------------------------------------------------------ */

const PILLARS: PillarDef[] = [
  {
    key: "trend",
    label: "絶対トレンド",
    weight: 1.0,
    standardized: true,
    rationale:
      "自分自身の 6〜12 ヶ月リターンは翌 1-3 ヶ月と正の関係を持つ (時系列モメンタム)。直近 1 ヶ月は反転効果が混ざるので 12-1 を使う。",
    parts: (f) => [
      { name: "12-1モメンタム", unit: "%", dir: 1, value: f.r12m1m },
      { name: "6ヶ月リターン", unit: "%", dir: 1, value: f.r6m },
    ],
    reading: (f, z) =>
      z === null
        ? "価格系列が足りず判定不能"
        : `12-1 ${fmtPct(f.r12m1m)} / 6ヶ月 ${fmtPct(f.r6m)} — 中期トレンドは${dirWord(z)}`,
  },
  {
    key: "relative",
    label: "相対力 (対 地域指数)",
    weight: 1.2,
    standardized: true,
    rationale:
      "業種単位のモメンタムは個別株モメンタムの主要因 (Moskowitz-Grinblatt 1999)。セクター選択では最も素直に効く柱。",
    parts: (f) => [
      { name: "RSレシオ", unit: "score", dir: 1, value: f.rsRatio },
      { name: "3ヶ月超過リターン", unit: "%", dir: 1, value: f.excess3m },
    ],
    reading: (f, z) =>
      z === null
        ? "比較対象の指数が取れていない"
        : `RSレシオ ${fmtNum(f.rsRatio, 1)} / 3ヶ月超過 ${fmtPct(f.excess3m)} — 指数に対して${z >= 0 ? "優位" : "劣後"}`,
  },
  {
    key: "accel",
    label: "相対力の加速",
    weight: 0.9,
    standardized: true,
    rationale:
      "相対力の水準ではなく変化率。順位が入れ替わる局面を、水準が入れ替わる前に拾う (RRG の縦軸と同じ量)。",
    parts: (f) => [
      { name: "RSモメンタム", unit: "score", dir: 1, value: f.rsMomentum },
      { name: "超過リターンの加速", unit: "%", dir: 1, value: f.excessAccel },
    ],
    reading: (f, z) =>
      z === null
        ? "加速度を測る履歴が足りない"
        : `RSモメンタム ${fmtNum(f.rsMomentum, 1)}${f.rotation ? ` (${quadrantJa(f.rotation.quadrant)})` : ""} — 資金の向きは${z >= 0 ? "流入" : "流出"}方向`,
  },
  {
    key: "reversal",
    label: "短期リバーサル",
    weight: 0.5,
    standardized: true,
    rationale:
      "1 週〜1 ヶ月の直近リターンは翌月に反転しやすい (Jegadeesh 1990)。モメンタムの柱と符号が逆になるのは仕様。上げ切った直後に飛び乗るのを抑える。",
    parts: (f) => [
      { name: "1週リターン", unit: "%", dir: -1, value: f.r1w },
      { name: "1ヶ月リターン", unit: "%", dir: -1, value: f.r1m },
    ],
    reading: (f, z) =>
      z === null
        ? "直近リターンが取れていない"
        : `1週 ${fmtPct(f.r1w)} / 1ヶ月 ${fmtPct(f.r1m)} — 短期は${z >= 0 ? "出遅れ (反発余地)" : "走り過ぎ (一服しやすい)"}`,
  },
  {
    key: "breadth",
    label: "参加の幅",
    weight: 0.7,
    standardized: true,
    rationale:
      "同じ上昇でも、構成銘柄が広く参加している上昇のほうが続く。代表 ETF だけが上がって中身が付いてきていない状態を減点する。",
    parts: (f) => [
      { name: "200日線超え比率", unit: "%", dir: 1, value: f.pctAbove200dma },
      { name: "50日線超え比率", unit: "%", dir: 1, value: f.pctAbove50dma },
    ],
    reading: (f, z) =>
      z === null
        ? "構成銘柄が少なく幅を測れない"
        : `構成銘柄の 200日線超え ${fmtPctPoint(f.pctAbove200dma)} / 50日線超え ${fmtPctPoint(f.pctAbove50dma)} — 裾野は${z >= 0 ? "広い" : "狭い"}`,
  },
  {
    key: "revision",
    label: "業績改定ドリフト",
    weight: 1.0,
    standardized: true,
    rationale:
      "アナリスト予想の改定方向は改定後もしばらく同じ向きに効き続ける。ファンダ側では最も短期に効く材料。",
    parts: (f) => [
      { name: "レーティング改定モメンタム", unit: "abs", dir: 1, value: f.ratingMomentum },
      { name: "EPS改定の正味方向", unit: "abs", dir: 1, value: f.epsRevisionNet },
      { name: "目標株価までの上値余地", unit: "%", dir: 1, value: f.upsideToTarget },
    ],
    reading: (f, z) =>
      z === null
        ? "アナリスト予想が取得できていない"
        : `EPS改定 ${fmtSigned(f.epsRevisionNet, 2)} / 目標まで ${fmtPct(f.upsideToTarget)} — 予想は${z >= 0 ? "上向き" : "下向き"}に改定`,
  },
  {
    key: "valuation",
    label: "バリュエーション",
    weight: 0.5,
    standardized: true,
    rationale:
      "割安さは 1-3 ヶ月ではほとんど効かないが、長期では効く。効かない期間があることを承知の上で軽く入れる (逆張り側)。",
    parts: (f) => [
      { name: "予想益回り", unit: "%", dir: 1, value: f.forwardEarningsYield },
      { name: "PBR中央値", unit: "x", dir: -1, value: f.priceToBook },
    ],
    reading: (f, z) =>
      z === null
        ? "ファンダメンタルズ未取得"
        : `予想益回り ${fmtPct(f.forwardEarningsYield)} / PBR ${fmtNum(f.priceToBook, 2)}倍 — 地域内では${z >= 0 ? "割安" : "割高"}`,
  },
  {
    key: "quality",
    label: "質・成長",
    weight: 0.6,
    standardized: true,
    rationale:
      "収益性の高さは長期のリターン差を説明する (Novy-Marx 2013)。短期の効き目は弱いので軽いウェイト。",
    parts: (f) => [
      { name: "ROE中央値", unit: "%", dir: 1, value: f.roe },
      { name: "増収率中央値", unit: "%", dir: 1, value: f.revenueGrowth },
    ],
    reading: (f, z) =>
      z === null
        ? "ファンダメンタルズ未取得"
        : `ROE ${fmtPct(f.roe, 1)} / 増収率 ${fmtPct(f.revenueGrowth, 1)} — 収益力は地域内で${z >= 0 ? "上位" : "下位"}`,
  },
  {
    key: "risk",
    label: "リスク",
    weight: 0.5,
    standardized: true,
    rationale:
      "ボラティリティはクラスタリングする (拡大したら当面続く)。拡大中・ドローダウン深耕中のセクターはリスク調整後で不利。",
    parts: (f) => [
      { name: "ボラ比 (20日/252日)", unit: "abs", dir: -1, value: f.volRatio },
      { name: "現在のドローダウン", unit: "%", dir: 1, value: f.currentDrawdown },
    ],
    reading: (f, z) =>
      z === null
        ? "リスク指標が計算できていない"
        : `ボラ比 ${fmtNum(f.volRatio, 2)} / ドローダウン ${fmtPct(f.currentDrawdown)} — リスクは${z >= 0 ? "落ち着いている" : "拡大方向"}`,
  },
  {
    key: "sentiment",
    label: "ニュース",
    weight: 0.4,
    standardized: true,
    rationale:
      "AI が読んだ見出しの強弱。材料の方向は掴めるがノイズが多いので、最も軽いウェイトに置く。",
    parts: (f) => [{ name: "センチメント", unit: "abs", dir: 1, value: f.sentimentScore }],
    reading: (f, z) => {
      const s = f.agg.sentiment;
      if (!s || z === null) return "関連する見出しが集まっていない";
      return `見出し ${s.headlineCount}件 / スコア ${fmtSigned(s.score, 2)} (${s.method === "workers-ai" ? "AI判定" : "語彙判定"})`;
    },
  },
  {
    key: "regime",
    label: "レジーム整合",
    weight: 0.6,
    standardized: false,
    rationale:
      "リスクオン局面ではシクリカル、リスクオフではディフェンシブが相対優位になる。横断標準化ではなく、相場地形から直接決まる絶対の傾きとして入れる。",
    parts: () => [],
    direct: (f) => regimeTilt(f),
    reading: (f, z) => regimeTilt(f).reading,
  },
  {
    key: "meanrev",
    label: "過熱 / 押し目",
    weight: 0.5,
    standardized: false,
    rationale:
      "RSI と 200 日線乖離が極端な領域に入ったときだけ効かせる非線形項。線形の Z にするとモメンタムの柱と単純に打ち消し合うため、閾値を超えた分だけを評価する。",
    parts: () => [],
    direct: (f) => meanReversionTilt(f),
    reading: (f) => meanReversionTilt(f).reading,
  },
  {
    key: "market",
    label: "市場の地合い",
    weight: 0.5,
    standardized: false,
    rationale:
      "柱 1-10 は地域内の相対で作っている (通貨と市場水準の差を落とすため)。地域をまたいで並べるときに、その市場自体の強弱を別途足す。",
    parts: () => [],
    direct: (f) => ({
      z: f.regionZ,
      reading:
        f.regionZ === null
          ? "地域指数が取れていない (地域間で比較できるだけの地域数が無い)"
          : `${REGION_META[f.region].nameJa}市場そのものが他地域比で${f.regionZ >= 0 ? "強い" : "弱い"} (Z ${fmtSigned(f.regionZ, 2)})`,
    }),
    reading: (f) =>
      f.regionZ === null
        ? "地域指数が取れていない"
        : `市場全体の強弱 Z ${fmtSigned(f.regionZ, 2)}`,
  },
];

/* ------------------------------------------------------------------ */
/* 表示ヘルパ                                                          */
/* ------------------------------------------------------------------ */

function fmtPct(x: number | null, d = 1): string {
  return isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—";
}
function fmtPctPoint(x: number | null, d = 0): string {
  return isNum(x) ? `${x.toFixed(d)}%` : "—";
}
function fmtNum(x: number | null, d = 2): string {
  return isNum(x) ? x.toFixed(d) : "—";
}
function fmtSigned(x: number | null, d = 2): string {
  return isNum(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "—";
}
function dirWord(z: number): string {
  return z >= 0.5 ? "明確に上向き" : z >= 0 ? "やや上向き" : z <= -0.5 ? "明確に下向き" : "やや下向き";
}
function quadrantJa(q: RotationPoint["quadrant"]): string {
  return { leading: "先行", weakening: "失速", lagging: "劣後", improving: "改善" }[q];
}

/* ------------------------------------------------------------------ */
/* 標準化しない柱                                                      */
/* ------------------------------------------------------------------ */

/**
 * レジーム整合。
 *
 * 「リスクオンだからシクリカル」を機械的に当てはめるのではなく、
 * リスク選好・トレンド・ボラの 3 軸それぞれから傾きを足し込む。
 * 3 軸が食い違っている地形 (上昇基調だがボラはストレス、など) では
 * 打ち消し合って自然に 0 に近づく。
 */
export function regimeTilt(f: {
  regime: Regime | null;
  cyclicality: "cyclical" | "defensive" | "neutral";
}): { z: number | null; reading: string } {
  const r = f.regime;
  if (!r || f.cyclicality === "neutral") {
    return {
      z: r ? 0 : null,
      reading: r
        ? "景気感応度が中間のセクター — 地形の追い風も向かい風も受けにくい"
        : "レジーム判定が未生成",
    };
  }
  const sign = f.cyclicality === "cyclical" ? 1 : -1;
  let tilt = 0;
  const notes: string[] = [];

  if (r.riskAppetite === "risk-on") {
    tilt += 0.6 * sign;
    notes.push("リスクオン");
  } else if (r.riskAppetite === "risk-off") {
    tilt -= 0.6 * sign;
    notes.push("リスクオフ");
  }
  if (r.trend === "bull") {
    tilt += 0.4 * sign * r.trendConfidence;
    notes.push("上昇基調");
  } else if (r.trend === "bear") {
    tilt -= 0.4 * sign * r.trendConfidence;
    notes.push("下降基調");
  }
  if (r.volatility === "stress") {
    tilt -= 0.5 * sign;
    notes.push("ボラはストレス水準");
  } else if (r.volatility === "low") {
    tilt += 0.2 * sign;
    notes.push("低ボラ");
  }

  const z = round(clamp(tilt, -1.5, 1.5), 3)!;
  const kind = f.cyclicality === "cyclical" ? "シクリカル" : "ディフェンシブ";
  return {
    z,
    reading: `${notes.join("・") || "中立な地形"} × ${kind} — 地形は${z > 0.15 ? "追い風" : z < -0.15 ? "向かい風" : "中立"}`,
  };
}

/**
 * 平均回帰 (過熱 / 押し目)。
 *
 * 閾値を超えた分だけを評価する非線形項。RSI 70 / 200日線乖離 +15% を
 * 超えた分は減点、RSI 35 / 乖離 −15% を割った分は加点する。
 * 中間帯では 0 を返すので、通常局面ではモメンタムの柱を邪魔しない。
 */
export function meanReversionTilt(f: {
  rsi: number | null;
  deviation200: number | null;
}): { z: number | null; reading: string } {
  if (!isNum(f.rsi) && !isNum(f.deviation200)) {
    return { z: null, reading: "テクニカル指標が取れていない" };
  }
  let tilt = 0;
  const notes: string[] = [];

  if (isNum(f.rsi)) {
    if (f.rsi > 70) {
      tilt -= (f.rsi - 70) / 15;
      notes.push(`RSI ${f.rsi.toFixed(0)} は買われ過ぎ`);
    } else if (f.rsi < 35) {
      tilt += (35 - f.rsi) / 15;
      notes.push(`RSI ${f.rsi.toFixed(0)} は売られ過ぎ`);
    }
  }
  if (isNum(f.deviation200)) {
    if (f.deviation200 > 0.15) {
      tilt -= (f.deviation200 - 0.15) / 0.15;
      notes.push(`200日線から +${(f.deviation200 * 100).toFixed(0)}% 上方乖離`);
    } else if (f.deviation200 < -0.15) {
      tilt += (-f.deviation200 - 0.15) / 0.15;
      notes.push(`200日線から ${(f.deviation200 * 100).toFixed(0)}% 下方乖離`);
    }
  }

  const z = round(clamp(tilt, -1.5, 1.5), 3)!;
  return {
    z,
    reading:
      notes.length === 0
        ? "過熱も売られ過ぎもなし (平均回帰の圧力は中立)"
        : `${notes.join(" / ")} — ${z < 0 ? "反落リスク" : "反発余地"}`,
  };
}

/* ------------------------------------------------------------------ */
/* 地域の強弱                                                          */
/* ------------------------------------------------------------------ */

/**
 * 地域そのものの強弱を Z にする。
 * 各地域のベンチマーク指数の 12-1 モメンタム・3 ヶ月リターン・200日線乖離を
 * 地域間で標準化して平均する。
 */
export function regionStrength(
  records: Record<string, InstrumentRecord>,
  regions: RegionId[]
): Map<RegionId, number | null> {
  const uniq = [...new Set(regions)];
  const benchOf = (r: RegionId): InstrumentRecord | null =>
    records[REGION_META[r]?.benchmark ?? ""] ?? null;

  const out = new Map<RegionId, number | null>();
  if (uniq.length < 3) {
    // 2 地域以下で「地域間の相対」を名乗っても意味が無い
    for (const r of uniq) out.set(r, null);
    return out;
  }

  const mom = zscores(uniq.map((r) => benchOf(r)?.price.r12m1m ?? null), { winsorizeAt: 0.1 });
  const r3m = zscores(uniq.map((r) => benchOf(r)?.price.r3m ?? null), { winsorizeAt: 0.1 });
  const dev = zscores(
    uniq.map((r) => benchOf(r)?.technicals.ma.deviation200 ?? null),
    { winsorizeAt: 0.1 }
  );

  uniq.forEach((r, i) => {
    const parts = [mom[i], r3m[i], dev[i]].filter(isNum);
    out.set(r, parts.length > 0 ? round(mean(parts), 3) : null);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 特徴量の抽出                                                        */
/* ------------------------------------------------------------------ */

function buildFeatures(
  agg: SectorAggregate,
  members: InstrumentRecord[],
  proxy: InstrumentRecord | null,
  rotation: RotationPoint | null,
  benchmark: InstrumentRecord | null,
  regionZ: number | null,
  regime: Regime | null
): CellFeatures {
  const pick = <T>(f: (r: InstrumentRecord) => T | null): (T | null)[] => members.map(f);

  const r12m1m = proxy?.price.r12m1m ?? num(pick((r) => r.price.r12m1m));
  const r6m = proxy?.price.r6m ?? num(pick((r) => r.price.r6m));
  const excess3m =
    isNum(agg.r3m) && isNum(benchmark?.price.r3m) ? agg.r3m - benchmark!.price.r3m! : null;
  const excess1m =
    isNum(agg.r1m) && isNum(benchmark?.price.r1m) ? agg.r1m - benchmark!.price.r1m! : null;
  // 1 ヶ月の超過を「3 ヶ月ペースを月割りしたもの」と比べる。
  // 直近だけ加速しているか減速しているかが出る。
  const excessAccel =
    isNum(excess1m) && isNum(excess3m) ? excess1m - excess3m / 3 : null;

  const forwardEarningsYield =
    isNum(agg.medianForwardPE) && agg.medianForwardPE > 0 ? 1 / agg.medianForwardPE : null;

  return {
    agg,
    region: agg.region,
    poolKey: agg.region,
    proxy,
    members,
    rotation,
    benchmark,
    r12m1m,
    r6m,
    rsRatio: rotation?.rsRatio ?? null,
    rsMomentum: rotation?.rsMomentum ?? null,
    excess3m,
    excess1m,
    excessAccel,
    r1w: agg.r1w,
    r1m: agg.r1m,
    pctAbove200dma: agg.pctAbove200dma,
    pctAbove50dma: (() => {
      const r = ratioTrue(pick((x) => x.technicals.ma.above.sma50));
      return r === null ? null : r * 100;
    })(),
    // recommendationMean は 1=強気買 … 5=強気売 なので、そのままだと符号が逆。
    // ratingMomentum は「強気化した量」なので向きはこのままで良い。
    ratingMomentum: num(pick((r) => r.consensus?.ratingMomentum ?? null)),
    epsRevisionNet: num(pick(epsRevisionNet)),
    upsideToTarget: num(pick((r) => r.consensus?.upsideToTarget ?? null)),
    forwardEarningsYield,
    priceToBook: agg.medianPB,
    roe: agg.medianROE,
    revenueGrowth: agg.medianRevenueGrowth,
    volRatio: proxy?.risk.volRatio ?? num(pick((r) => r.risk.volRatio)),
    currentDrawdown: proxy?.risk.currentDrawdown ?? num(pick((r) => r.risk.currentDrawdown)),
    rsi: agg.meanRsi ?? proxy?.technicals.rsi14 ?? null,
    deviation200: proxy?.technicals.ma.deviation200 ?? num(pick((r) => r.technicals.ma.deviation200)),
    sentimentScore:
      agg.sentiment && agg.sentiment.headlineCount >= 2 ? agg.sentiment.score : null,
    atrPercent: proxy?.technicals.atrPercent ?? num(pick((r) => r.technicals.atrPercent)),
    regionZ,
    cyclicality: SECTOR_CYCLICALITY[agg.sector] ?? "neutral",
    regime,
  };
}

/* ------------------------------------------------------------------ */
/* 本体                                                                */
/* ------------------------------------------------------------------ */

export interface OutlookInput {
  sectors: SectorAggregate[];
  records: Record<string, InstrumentRecord>;
  rotation: RotationPoint[];
  regime: Regime | null;
  news: NewsItem[];
  /** ランキングに載せる件数 (上位・下位それぞれ) */
  topN?: number;
}

/** 「市場全体」「マクロ」はセクターローテーションの対象ではないので外す */
const EXCLUDED_SECTORS = new Set(["broad", "macro"]);

export function buildOutlook(input: OutlookInput): OutlookBoard | null {
  const { sectors, records, rotation, regime, news } = input;
  const topN = input.topN ?? 5;

  const cellMembers = new Map<string, string[]>();
  for (const cell of sectorCells()) {
    cellMembers.set(
      `${cell.region}/${cell.sector}`,
      cell.members.map((m) => m.symbol)
    );
  }
  const rotationBySymbol = new Map(rotation.map((r) => [r.symbol, r]));

  const candidates = sectors.filter(
    (s) =>
      !EXCLUDED_SECTORS.has(s.sector) &&
      (s.proxySymbol !== null || s.memberCount >= 2)
  );
  if (candidates.length < 4) return null;

  const regionZ = regionStrength(records, candidates.map((c) => c.region));

  const features: CellFeatures[] = candidates.map((agg) => {
    const symbols = cellMembers.get(`${agg.region}/${agg.sector}`) ?? [];
    const members = symbols
      .map((s) => records[s])
      .filter((r): r is InstrumentRecord => !!r);
    const proxy = agg.proxySymbol ? (records[agg.proxySymbol] ?? null) : null;
    const bench = records[REGION_META[agg.region]?.benchmark ?? ""] ?? null;
    return buildFeatures(
      agg,
      members,
      proxy,
      agg.proxySymbol ? (rotationBySymbol.get(agg.proxySymbol) ?? null) : null,
      bench,
      regionZ.get(agg.region) ?? null,
      regime
    );
  });

  /*
   * プール分け。
   * 地域内で標準化するのが原則 (通貨と市場水準の差を落とすため) だが、
   * セルが 4 つ未満の地域で Z を取ると「3 つ中 3 位だから最下位」という
   * 無意味なスコアになる。その地域は全体プールに合流させる。
   */
  const regionCount = new Map<string, number>();
  for (const f of features) {
    regionCount.set(f.agg.region, (regionCount.get(f.agg.region) ?? 0) + 1);
  }
  for (const f of features) {
    f.poolKey = (regionCount.get(f.agg.region) ?? 0) >= 4 ? f.agg.region : "POOLED";
  }

  /* ---- 柱ごとに Z を計算 ---- */
  const pillarZ = new Map<string, (number | null)[]>();
  for (const def of PILLARS) {
    if (!def.standardized) {
      pillarZ.set(
        def.key,
        features.map((f) => (def.direct ? def.direct(f).z : null))
      );
      continue;
    }
    // パーツごとにプール内で標準化し、方向を揃えてから平均する
    const partCount = def.parts(features[0]).length;
    const partZ: (number | null)[][] = [];
    for (let p = 0; p < partCount; p++) {
      const raw = features.map((f) => {
        const part = def.parts(f)[p];
        return isNum(part.value) ? part.value * part.dir : null;
      });
      partZ.push(zByPool(raw, features.map((f) => f.poolKey)));
    }
    pillarZ.set(
      def.key,
      features.map((_, i) => {
        const vals = partZ.map((arr) => arr[i]).filter(isNum);
        return vals.length > 0 ? round(mean(vals), 3) : null;
      })
    );
  }

  /* ---- 合成 ---- */
  const totalWeight = PILLARS.reduce((a, p) => a + p.weight, 0);
  const rows: SectorOutlook[] = features.map((f, i) => {
    const pillars: OutlookPillar[] = PILLARS.map((def) => {
      const z = pillarZ.get(def.key)![i];
      return {
        key: def.key,
        label: def.label,
        weight: def.weight,
        z,
        contribution: 0, // 下で埋める
        standardized: def.standardized,
        reading: def.direct ? def.direct(f).reading : def.reading(f, z),
        inputs: def.parts(f).map((p) => ({ name: p.name, value: round(p.value, 4), unit: p.unit })),
      };
    });

    const usable = pillars.filter((p) => isNum(p.z));
    const usedWeight = usable.reduce((a, p) => a + p.weight, 0);
    const coverage = usedWeight / totalWeight;
    const z = usedWeight > 0 ? usable.reduce((a, p) => a + p.z! * p.weight, 0) / usedWeight : 0;

    for (const p of pillars) {
      p.contribution = isNum(p.z) && usedWeight > 0 ? round((p.z * p.weight) / usedWeight, 4)! : 0;
      p.z = round(p.z, 3);
    }

    // 一致率: 合成の符号と同じ向きの柱がウェイトの何割を占めるか
    const agreeWeight = usable
      .filter((p) => (p.z! >= 0) === (z >= 0))
      .reduce((a, p) => a + p.weight, 0);
    const agreement = usedWeight > 0 ? agreeWeight / usedWeight : 0;

    const strength = Math.min(1, Math.abs(z) / 0.8);
    const conviction = Math.round(
      100 * coverage * (0.35 + 0.65 * agreement) * (0.4 + 0.6 * strength)
    );

    const ranked = [...pillars]
      .filter((p) => isNum(p.z))
      .sort((a, b) => b.contribution - a.contribution);
    const drivers = ranked
      .filter((p) => p.contribution > 0.02)
      .slice(0, 3)
      .map((p) => `${p.label}: ${p.reading}`);
    const risks = ranked
      .filter((p) => p.contribution < -0.02)
      .reverse()
      .slice(0, 3)
      .map((p) => `${p.label}: ${p.reading}`);

    const direction: SectorOutlook["direction"] = z >= 0.25 ? "up" : z <= -0.25 ? "down" : "neutral";
    const headlines = matchHeadlines(news, SECTOR_META[f.agg.sector].keywords, 5);

    return {
      region: f.agg.region,
      sector: f.agg.sector,
      nameJa: f.agg.nameJa,
      nameEn: f.agg.nameEn,
      proxySymbol: f.agg.proxySymbol,
      memberCount: f.agg.memberCount,
      z: round(z, 3)!,
      score: zToScore(z)!,
      direction,
      horizon: OUTLOOK_HORIZON,
      agreement: round(agreement, 3)!,
      coverage: round(coverage, 3)!,
      conviction,
      rank: 0,
      rankOf: features.length,
      pillars,
      drivers,
      risks,
      thesis: buildThesis(f, z, direction, drivers, risks),
      invalidation: buildInvalidation(f, direction),
      expectedMove1m: isNum(f.atrPercent) ? round(f.atrPercent * Math.sqrt(21), 4) : null,
      sentiment: f.agg.sentiment,
      headlines,
    };
  });

  rows.sort((a, b) => b.z - a.z || a.region.localeCompare(b.region));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });

  // カバレッジが低すぎる (材料が半分も揃っていない) セルは、
  // 順位表には残すが「上がる/下がる」の推薦からは外す。
  // 材料が 2 本しか無いセルが偶然 1 位になるのを防ぐため。
  const eligible = rows.filter((r) => r.coverage >= 0.45);

  const summarize = (r: SectorOutlook): SectorOutlookRow => {
    const ranked = [...r.pillars].filter((p) => isNum(p.z));
    const best = ranked.reduce<OutlookPillar | null>(
      (a, p) => (a === null || p.contribution > a.contribution ? p : a),
      null
    );
    const worst = ranked.reduce<OutlookPillar | null>(
      (a, p) => (a === null || p.contribution < a.contribution ? p : a),
      null
    );
    return {
      region: r.region,
      sector: r.sector,
      nameJa: r.nameJa,
      proxySymbol: r.proxySymbol,
      memberCount: r.memberCount,
      z: r.z,
      score: r.score,
      direction: r.direction,
      conviction: r.conviction,
      coverage: r.coverage,
      agreement: r.agreement,
      rank: r.rank,
      topDriver: best && best.contribution > 0 ? best.label : null,
      topRisk: worst && worst.contribution < 0 ? worst.label : null,
    };
  };

  return {
    asOf: new Date().toISOString(),
    horizon: OUTLOOK_HORIZON,
    bullish: eligible.filter((r) => r.z > 0).slice(0, topN),
    bearish: eligible
      .filter((r) => r.z < 0)
      .slice(-topN)
      .reverse(),
    all: rows.map(summarize),
    method:
      "13本の柱 (トレンド / 相対力 / 加速 / 短期リバーサル / 参加の幅 / 業績改定 / バリュエーション / 質・成長 / リスク / ニュース / レジーム整合 / 平均回帰 / 市場の地合い) を " +
      "地域内で標準化してウェイト加重した合成シグナル。score は上昇確率ではなく、同じ土俵に並べたときの相対順位を 0-100 に写したもの。" +
      "想定時間軸は " + OUTLOOK_HORIZON + "。柱が食い違っているケースは conviction が下がる。",
    weights: PILLARS.map((p) => ({
      key: p.key,
      label: p.label,
      weight: round(p.weight / totalWeight, 4)!,
      rationale: p.rationale,
    })),
  };
}

/** プール単位で Z を取る (プールをまたいだ比較はしない) */
function zByPool(raw: (number | null)[], pools: PoolKey[]): (number | null)[] {
  const out: (number | null)[] = new Array(raw.length).fill(null);
  const groups = new Map<PoolKey, number[]>();
  pools.forEach((p, i) => {
    const g = groups.get(p) ?? [];
    g.push(i);
    groups.set(p, g);
  });
  for (const idxs of groups.values()) {
    // winsorize でリターンの外れ値 (単月 +40% のような値) が
    // 分布全体を潰すのを防ぐ。robust は使わない — セル数が少なく
    // MAD が 0 になるケースがあるため。
    const z = zscores(idxs.map((i) => raw[i]), { winsorizeAt: 0.1 });
    idxs.forEach((i, k) => {
      out[i] = z[k];
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 文章化                                                              */
/* ------------------------------------------------------------------ */

function buildThesis(
  f: CellFeatures,
  z: number,
  direction: SectorOutlook["direction"],
  drivers: string[],
  risks: string[]
): string {
  const name = f.agg.nameJa;
  const head =
    direction === "up"
      ? `${name}は ${OUTLOOK_HORIZON} で買い優位`
      : direction === "down"
        ? `${name}は ${OUTLOOK_HORIZON} で売り優位 (または回避)`
        : `${name}は方向感に乏しい`;

  const bits: string[] = [];
  if (isNum(f.rsRatio)) {
    bits.push(
      `対${REGION_META[f.agg.region].nameJa}指数の相対力は${f.rsRatio >= 100 ? "上位" : "下位"}` +
        (f.rotation ? ` (${quadrantJa(f.rotation.quadrant)}象限)` : "")
    );
  } else if (isNum(f.excess3m)) {
    bits.push(`3ヶ月の指数超過は ${fmtPct(f.excess3m)}`);
  }
  if (isNum(f.pctAbove200dma)) {
    bits.push(`構成銘柄の ${fmtPctPoint(f.pctAbove200dma)} が 200日線の上`);
  }
  if (isNum(f.epsRevisionNet) || isNum(f.upsideToTarget)) {
    bits.push(
      `アナリスト予想は${isNum(f.epsRevisionNet) && f.epsRevisionNet < 0 ? "下方" : "上方"}改定寄り`
    );
  }

  const counter =
    direction === "up" && risks.length > 0
      ? `ただし${risks[0].split(":")[0]}は逆向き。`
      : direction === "down" && drivers.length > 0
        ? `ただし${drivers[0].split(":")[0]}は逆向き。`
        : "";

  return `${head} (合成Z ${fmtSigned(z, 2)})。${bits.join("、")}${bits.length ? "。" : ""}${counter}`;
}

/**
 * 否定条件。
 *
 * 「上がると思う」だけ書いて外れたときに黙るのが一番たちが悪いので、
 * 何が起きたら見立てが崩れるかを価格の水準で先に書いておく。
 */
function buildInvalidation(f: CellFeatures, direction: SectorOutlook["direction"]): string {
  const sym = f.agg.proxySymbol;
  const sma200 = f.proxy?.technicals.ma.sma200 ?? null;
  const last = f.proxy?.price.last ?? null;

  if (sym && isNum(sma200) && isNum(last)) {
    const cur = f.proxy!.price.currency;
    if (direction === "down") {
      return `${sym} が 200日線 ${sma200.toFixed(2)} ${cur} を終値で上抜け、RSレシオが 100 を回復したら弱気の見立ては無効。`;
    }
    return `${sym} が 200日線 ${sma200.toFixed(2)} ${cur} (現値 ${last.toFixed(2)} / 乖離 ${fmtPct(f.deviation200)}) を終値で割るか、RSレシオが 100 を下回ったら見立ては無効。`;
  }
  const bench = REGION_META[f.agg.region].benchmark;
  return `${bench} に対する 3ヶ月超過リターン (現在 ${fmtPct(f.excess3m)}) が ${direction === "down" ? "プラス転換" : "マイナス転換"}したら見立ては無効。`;
}
