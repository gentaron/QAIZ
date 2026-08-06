import type {
  Consensus,
  FactorScores,
  Fundamentals,
  PriceSummary,
  RiskMetrics,
  Scorecard,
  Signal,
  Technicals,
} from "../types.ts";
import { isNum } from "./stats.ts";

/**
 * シグナル生成。
 *
 * 「買い」「売り」を吐く箱にはしていない。出すのは *観測された事実* と
 * その解釈で、判断は使う人が下す。だから全シグナルに detail で
 * 「何がどうなっているか」の実数を必ず書く。数字の無いシグナルは
 * 占いと区別できない。
 *
 * strength: 1 = 参考, 2 = 通常, 3 = 強い (複数条件の合致)
 */

export interface SignalInput {
  price: PriceSummary;
  technicals: Technicals;
  risk: RiskMetrics;
  fundamentals: Fundamentals | null;
  consensus: Consensus | null;
  valuation: Scorecard | null;
  quality: Scorecard | null;
  growth: Scorecard | null;
  factors: FactorScores | null;
}

const pct = (x: number | null | undefined, digits = 1): string =>
  isNum(x) ? `${(x * 100).toFixed(digits)}%` : "—";

function metric(card: Scorecard | null, key: string) {
  return card?.metrics.find((m) => m.key === key) ?? null;
}

export function generateSignals(inp: SignalInput): Signal[] {
  const out: Signal[] = [];
  const t = inp.technicals;
  const p = inp.price;
  const push = (s: Signal) => out.push(s);

  /* ---------------- テクニカル ---------------- */

  if (t.ma.cross === "golden" && isNum(t.ma.crossAgeDays) && t.ma.crossAgeDays <= 25) {
    push({
      id: "golden-cross",
      category: "technical",
      direction: "bullish",
      strength: t.ma.perfectOrder === "bullish" ? 3 : 2,
      title: "ゴールデンクロス成立",
      detail: `50日線が200日線を${t.ma.crossAgeDays}営業日前に上抜け。${t.ma.perfectOrder === "bullish" ? "5/20/50/200日線がパーフェクトオーダー (上昇の初動として質が高い)。" : "移動平均の並びはまだ整っていない。"}`,
    });
  }
  if (t.ma.cross === "dead" && isNum(t.ma.crossAgeDays) && t.ma.crossAgeDays <= 25) {
    push({
      id: "dead-cross",
      category: "technical",
      direction: "bearish",
      strength: t.ma.perfectOrder === "bearish" ? 3 : 2,
      title: "デッドクロス成立",
      detail: `50日線が200日線を${t.ma.crossAgeDays}営業日前に下抜け。中期トレンドの転換シグナル。`,
    });
  }

  if (t.rsiDivergence === "bullish") {
    push({
      id: "rsi-bull-div",
      category: "technical",
      direction: "bullish",
      strength: t.rsi14State === "oversold" ? 3 : 2,
      title: "RSI強気ダイバージェンス",
      detail: `価格は安値を切り下げているのにRSIは切り上げ (現在 ${t.rsi14?.toFixed(1) ?? "—"})。下げの勢いが減衰している。`,
    });
  }
  if (t.rsiDivergence === "bearish") {
    push({
      id: "rsi-bear-div",
      category: "technical",
      direction: "bearish",
      strength: t.rsi14State === "overbought" ? 3 : 2,
      title: "RSI弱気ダイバージェンス",
      detail: `価格は高値を切り上げているのにRSIは切り下げ (現在 ${t.rsi14?.toFixed(1) ?? "—"})。上げの勢いが減衰している。`,
    });
  }
  if (t.rsi14State === "overbought") {
    push({
      id: "rsi-overbought",
      category: "technical",
      direction: "caution",
      strength: 1,
      title: "RSI過熱圏",
      detail: `RSI(14) = ${t.rsi14?.toFixed(1)}。上昇トレンド中のRSI高止まりは珍しくないので単独では売り根拠にならないが、追撃のタイミングとしては不利。`,
    });
  }
  if (t.rsi14State === "oversold") {
    push({
      id: "rsi-oversold",
      category: "technical",
      direction: "caution",
      strength: 1,
      title: "RSI売られすぎ",
      detail: `RSI(14) = ${t.rsi14?.toFixed(1)}。反発余地はあるが、下降トレンド中は「安いまま下がる」ことのほうが多い。`,
    });
  }

  if (t.bollinger?.squeeze) {
    push({
      id: "bb-squeeze",
      category: "technical",
      direction: "caution",
      strength: 2,
      title: "ボリンジャー・スクイーズ",
      detail: `バンド幅が直近120日で下位20%タイル (${t.bollinger.bandwidthPercentile?.toFixed(0) ?? "?"}%タイル)。方向は示さないが、大きな値動きの前触れになりやすい。`,
    });
  }

  if (t.adx && t.adx.regime === "trending") {
    push({
      id: "adx-trend",
      category: "technical",
      direction: t.adx.direction === "up" ? "bullish" : "bearish",
      strength: t.adx.adx >= 35 ? 3 : 2,
      title: `明確な${t.adx.direction === "up" ? "上昇" : "下降"}トレンド`,
      detail: `ADX ${t.adx.adx.toFixed(1)} (25超でトレンド)。+DI ${t.adx.plusDi.toFixed(1)} / -DI ${t.adx.minusDi.toFixed(1)}。順張りが機能しやすい状態。`,
    });
  }
  if (t.adx && t.adx.regime === "ranging") {
    push({
      id: "adx-range",
      category: "technical",
      direction: "caution",
      strength: 1,
      title: "レンジ相場",
      detail: `ADX ${t.adx.adx.toFixed(1)} (20未満)。ブレイクアウトの騙しが増える地合い。支持/抵抗での往復を想定。`,
    });
  }

  if (isNum(p.volumeRatio) && p.volumeRatio >= 2) {
    push({
      id: "volume-spike",
      category: "technical",
      direction: isNum(p.r1d) && p.r1d > 0 ? "bullish" : "caution",
      strength: 2,
      title: "出来高急増",
      detail: `直近出来高は20日平均の${p.volumeRatio.toFixed(1)}倍。当日リターン ${pct(p.r1d)}。何らかの材料が出ている可能性が高い。`,
    });
  }

  if (isNum(p.rangePosition52w) && p.rangePosition52w >= 0.98) {
    push({
      id: "new-high",
      category: "momentum",
      direction: "bullish",
      strength: 2,
      title: "52週高値圏",
      detail: `52週レンジの上端 (${(p.rangePosition52w * 100).toFixed(0)}%タイル)。高値更新銘柄はモメンタムが持続しやすい一方、押し目がないぶん撤退ラインを引きにくい。`,
    });
  }
  if (isNum(p.drawdownFrom52wHigh) && p.drawdownFrom52wHigh <= -0.2) {
    push({
      id: "deep-drawdown",
      category: "risk",
      direction: "caution",
      strength: p.drawdownFrom52wHigh <= -0.35 ? 3 : 2,
      title: "52週高値から大幅安",
      detail: `高値から ${pct(p.drawdownFrom52wHigh)}。戻り高値の抵抗が上に積み上がっているため、反発しても上値は重い。`,
    });
  }

  const nearResistance = t.levels.resistance[0];
  if (nearResistance && Math.abs(nearResistance.distancePct) <= 0.02) {
    push({
      id: "at-resistance",
      category: "technical",
      direction: "caution",
      strength: nearResistance.touches >= 3 ? 2 : 1,
      title: "抵抗帯に接近",
      detail: `${nearResistance.level} 付近 (現値から ${pct(nearResistance.distancePct)}) に過去${nearResistance.touches}回反落した水準。抜ければ上放れ、跳ね返されれば往って来い。`,
    });
  }
  const nearSupport = t.levels.support[0];
  if (nearSupport && Math.abs(nearSupport.distancePct) <= 0.02) {
    push({
      id: "at-support",
      category: "technical",
      direction: "caution",
      strength: nearSupport.touches >= 3 ? 2 : 1,
      title: "支持帯に接近",
      detail: `${nearSupport.level} 付近 (現値から ${pct(nearSupport.distancePct)}) に過去${nearSupport.touches}回下支えられた水準。割れると下落が加速しやすい。`,
    });
  }

  /* ---------------- バリュエーション ---------------- */

  const fpe = metric(inp.valuation, "forwardPE");
  const pbr = metric(inp.valuation, "priceToBook");
  const fcf = metric(inp.valuation, "fcfYield");

  if (fpe && isNum(fpe.percentile) && fpe.percentile >= 80 && isNum(fpe.value)) {
    push({
      id: "cheap-forward-pe",
      category: "valuation",
      direction: "bullish",
      strength: fpe.percentile >= 92 ? 3 : 2,
      title: "予想PERがセクター内で割安",
      detail: `予想PER ${fpe.value.toFixed(1)}倍 (セクター中央値 ${fpe.peerMedian?.toFixed(1) ?? "—"}倍)。同業比で下位${(100 - fpe.percentile).toFixed(0)}%の水準。`,
    });
  }
  if (fpe && isNum(fpe.percentile) && fpe.percentile <= 15 && isNum(fpe.value)) {
    push({
      id: "rich-forward-pe",
      category: "valuation",
      direction: "caution",
      strength: 2,
      title: "予想PERがセクター内で割高",
      detail: `予想PER ${fpe.value.toFixed(1)}倍 (セクター中央値 ${fpe.peerMedian?.toFixed(1) ?? "—"}倍)。成長が続く前提が既に価格に入っている。`,
    });
  }
  if (pbr && isNum(pbr.value) && pbr.value < 1) {
    push({
      id: "below-book",
      category: "valuation",
      direction: "bullish",
      strength: 2,
      title: "PBR 1倍割れ",
      detail: `PBR ${pbr.value.toFixed(2)}倍。解散価値割れ。ただしROEが低いままなら「安いのには理由がある」ケースが大半なので、ROEと併読が必須。`,
    });
  }
  if (fcf && isNum(fcf.value) && fcf.value >= 0.07) {
    push({
      id: "high-fcf-yield",
      category: "valuation",
      direction: "bullish",
      strength: 2,
      title: "FCF利回りが高い",
      detail: `FCF利回り ${pct(fcf.value)}。会計利益ではなく現金の裏付けがあるバリュー。自社株買い・増配の原資になる。`,
    });
  }

  /* ---------------- クオリティ ---------------- */

  const roe = metric(inp.quality, "returnOnEquity");
  const de = metric(inp.quality, "debtToEquity");
  const om = metric(inp.quality, "operatingMargin");
  const nde = metric(inp.quality, "netDebtToEbitda");

  if (roe && isNum(roe.value) && roe.value >= 0.15 && de && isNum(de.value) && de.value <= 100) {
    push({
      id: "quality-compounder",
      category: "quality",
      direction: "bullish",
      strength: roe.value >= 0.25 ? 3 : 2,
      title: "高ROE × 低レバレッジ",
      detail: `ROE ${pct(roe.value)} を D/E ${de.value.toFixed(0)}% で達成。借入で嵩上げしていない本物の資本効率。`,
    });
  }
  if (roe && isNum(roe.value) && roe.value < 0.05) {
    push({
      id: "low-roe",
      category: "quality",
      direction: "caution",
      strength: 2,
      title: "資本効率が低い",
      detail: `ROE ${pct(roe.value)}。株主資本を使って利益を生めていない。PBRが低くてもバリュートラップになりやすい典型。`,
    });
  }
  if (om && isNum(om.value) && om.value < 0) {
    push({
      id: "negative-margin",
      category: "quality",
      direction: "bearish",
      strength: 3,
      title: "営業赤字",
      detail: `営業利益率 ${pct(om.value)}。PER等の利益ベース指標は意味を失うため、キャッシュ残存期間で見るべき局面。`,
    });
  }
  if (nde && isNum(nde.value) && nde.value >= 4) {
    push({
      id: "high-leverage",
      category: "risk",
      direction: "caution",
      strength: nde.value >= 6 ? 3 : 2,
      title: "有利子負債が重い",
      detail: `ネット有利子負債 / EBITDA = ${nde.value.toFixed(1)}倍。金利上昇局面では利払いが利益を圧迫する。`,
    });
  }

  /* ---------------- 成長 ---------------- */

  const rg = metric(inp.growth, "revenueGrowth");
  const eg = metric(inp.growth, "earningsGrowth");
  if (rg && isNum(rg.value) && rg.value >= 0.2 && eg && isNum(eg.value) && eg.value >= 0.2) {
    push({
      id: "dual-growth",
      category: "quality",
      direction: "bullish",
      strength: 3,
      title: "増収増益が両立",
      detail: `売上 ${pct(rg.value, 0)} / 利益 ${pct(eg.value, 0)} の成長。コスト削減ではなくトップラインが伸びている。`,
    });
  }
  if (eg && isNum(eg.value) && eg.value <= -0.2) {
    push({
      id: "earnings-decline",
      category: "quality",
      direction: "bearish",
      strength: 2,
      title: "減益",
      detail: `利益成長率 ${pct(eg.value, 0)}。PERの分母が縮んでいるため、株価が横ばいでも実質的には割高化している。`,
    });
  }

  /* ---------------- コンセンサス ---------------- */

  const c = inp.consensus;
  if (c && isNum(c.upsideToTarget) && isNum(c.analystCount) && c.analystCount >= 5) {
    if (c.upsideToTarget >= 0.2) {
      push({
        id: "target-upside",
        category: "consensus",
        direction: "bullish",
        strength: c.upsideToTarget >= 0.35 ? 3 : 2,
        title: "目標株価まで上値余地",
        detail: `アナリスト${c.analystCount}名の平均目標 ${c.targetMean?.toFixed(2) ?? "—"} に対し現値は ${pct(c.upsideToTarget, 0)} 下。目標株価は上方に偏るバイアスがあるため、乖離の「変化」を見るのが実務。`,
      });
    } else if (c.upsideToTarget <= -0.05) {
      push({
        id: "target-exceeded",
        category: "consensus",
        direction: "caution",
        strength: 2,
        title: "目標株価を超過",
        detail: `平均目標 ${c.targetMean?.toFixed(2) ?? "—"} を現値が上回っている (乖離 ${pct(c.upsideToTarget, 0)})。目標が引き上げられなければ格下げ余地。`,
      });
    }
  }
  if (c && isNum(c.ratingMomentum) && Math.abs(c.ratingMomentum) >= 0.15) {
    push({
      id: "rating-momentum",
      category: "consensus",
      direction: c.ratingMomentum > 0 ? "bullish" : "bearish",
      strength: 2,
      title: `レーティングが${c.ratingMomentum > 0 ? "強気化" : "弱気化"}`,
      detail: `直近3ヶ月でアナリストの推奨分布が${c.ratingMomentum > 0 ? "買い" : "売り"}方向にシフト (変化量 ${c.ratingMomentum.toFixed(2)})。改定の方向は株価に先行しやすい。`,
    });
  }
  if (c && isNum(c.targetDispersion) && c.targetDispersion >= 0.6) {
    push({
      id: "target-dispersion",
      category: "consensus",
      direction: "caution",
      strength: 1,
      title: "アナリストの見方が割れている",
      detail: `目標株価のばらつき (高値−安値)/平均 = ${c.targetDispersion.toFixed(2)}。強気・弱気の前提が食い違っている = イベントドリブンで大きく動きやすい。`,
    });
  }

  /* ---------------- リスク ---------------- */

  if (isNum(inp.risk.volRatio) && inp.risk.volRatio >= 1.5) {
    push({
      id: "vol-expansion",
      category: "risk",
      direction: "caution",
      strength: 2,
      title: "ボラティリティ拡大中",
      detail: `直近20日ボラが1年平均の${inp.risk.volRatio.toFixed(2)}倍 (年率 ${pct(inp.risk.vol20, 0)})。同じ株数でもリスク量が増えている。`,
    });
  }
  if (isNum(inp.risk.skewness) && inp.risk.skewness <= -0.6 && isNum(inp.risk.kurtosis) && inp.risk.kurtosis >= 3) {
    push({
      id: "fat-left-tail",
      category: "risk",
      direction: "caution",
      strength: 2,
      title: "左に厚いテール",
      detail: `歪度 ${inp.risk.skewness.toFixed(2)} / 超過尖度 ${inp.risk.kurtosis.toFixed(2)}。急落が正規分布の想定より起きやすい形。CVaR(95%) は日次 ${pct(inp.risk.cvar95)}。`,
    });
  }
  if (isNum(inp.risk.beta) && inp.risk.beta >= 1.5) {
    push({
      id: "high-beta",
      category: "risk",
      direction: "caution",
      strength: 1,
      title: "ハイベータ",
      detail: `β = ${inp.risk.beta.toFixed(2)} (対 ${inp.risk.benchmark ?? "ベンチマーク"}, R² ${inp.risk.rSquared?.toFixed(2) ?? "—"})。市場が下げるとき増幅される。`,
    });
  }

  /* ---------------- 合成の読み ---------------- */

  const f = inp.factors;
  if (f && isNum(f.value) && isNum(f.momentum) && f.value >= 70 && f.momentum <= 35) {
    push({
      id: "value-trap-risk",
      category: "valuation",
      direction: "caution",
      strength: 2,
      title: "バリュートラップ警戒",
      detail: `バリュー ${f.value.toFixed(0)}点と割安な一方、モメンタム ${f.momentum.toFixed(0)}点と株価は下向き。安いまま下がり続ける典型パターンなので、業績の底打ち確認が要る。`,
    });
  }
  if (f && isNum(f.quality) && isNum(f.momentum) && f.quality >= 70 && f.momentum >= 70) {
    push({
      id: "quality-momentum",
      category: "momentum",
      direction: "bullish",
      strength: 3,
      title: "クオリティ × モメンタムの合致",
      detail: `クオリティ ${f.quality.toFixed(0)}点 / モメンタム ${f.momentum.toFixed(0)}点。実証的に最も頑健とされる組み合わせ (総合${f.rank ?? "—"}位 / ${f.peerCount}銘柄)。`,
    });
  }

  // 強いものから、同強度なら強気→弱気→注意の順
  const dirOrder = { bullish: 0, bearish: 1, caution: 2 };
  return out.sort(
    (a, b) => b.strength - a.strength || dirOrder[a.direction] - dirOrder[b.direction]
  );
}
