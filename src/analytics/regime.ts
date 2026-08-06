import type { Breadth, InstrumentRecord, Regime } from "../types.ts";
import { isNum, round } from "./stats.ts";

/**
 * 相場レジーム判定。
 *
 * 単一指標でレジームを名乗らない。トレンド (指数と移動平均)、
 * ボラティリティ (VIX の水準と自分の 1 年レンジ内位置)、リスク選好
 * (信用スプレッド代理・銅金レシオ・小型/大型) の 3 軸を別々に判定し、
 * それぞれの根拠を evidence に残す。
 *
 * 判定は「今どういう地形にいるか」の記述であって、予測ではない。
 * playbook もその地形で外しにくい戦術に限定している。
 */

interface Ctx {
  get(symbol: string): InstrumentRecord | undefined;
}

function spread(a: number | null | undefined, b: number | null | undefined): number | null {
  return isNum(a) && isNum(b) ? a - b : null;
}

export function computeRegime(
  records: Record<string, InstrumentRecord>,
  breadth: Breadth | null
): Regime | null {
  const ctx: Ctx = { get: (s) => records[s] };
  const spx = ctx.get("^GSPC");
  if (!spx) return null;

  const evidence: Regime["evidence"] = [];

  /* --- トレンド --- */
  let trendScore = 0;
  const above200 = spx.technicals.ma.above.sma200;
  if (above200 !== null) {
    trendScore += above200 ? 1 : -1;
    evidence.push({
      name: "S&P500 対 200日線",
      value: spx.technicals.ma.deviation200,
      reading: above200 ? "200日線の上 (上昇基調)" : "200日線の下 (下降基調)",
    });
  }
  if (spx.technicals.ma.cross !== "none") {
    trendScore += spx.technicals.ma.cross === "golden" ? 0.7 : -0.7;
    evidence.push({
      name: "50日線 / 200日線",
      value: null,
      reading: spx.technicals.ma.cross === "golden" ? "ゴールデンクロス" : "デッドクロス",
    });
  }
  const adx = spx.technicals.adx;
  if (adx) {
    evidence.push({
      name: "S&P500 ADX(14)",
      value: adx.adx,
      reading:
        adx.regime === "trending"
          ? `トレンド継続中 (方向: ${adx.direction === "up" ? "上" : "下"})`
          : adx.regime === "ranging"
            ? "方向感なし (レンジ)"
            : "移行期",
    });
    if (adx.regime === "ranging") trendScore *= 0.5;
    else trendScore += adx.direction === "up" ? 0.4 : -0.4;
  }
  if (breadth && isNum(breadth.pctAbove200dma)) {
    const p = breadth.pctAbove200dma;
    trendScore += p >= 60 ? 0.6 : p <= 40 ? -0.6 : 0;
    evidence.push({
      name: "200日線超えの銘柄比率",
      value: p,
      reading: `${p.toFixed(0)}% — 上昇の裾野は${p >= 60 ? "広い" : p <= 40 ? "狭い" : "まちまち"}`,
    });
  }

  const trend: Regime["trend"] = trendScore >= 1 ? "bull" : trendScore <= -1 ? "bear" : "range";
  const trendConfidence = round(Math.min(1, Math.abs(trendScore) / 2.7), 2)!;

  /* --- ボラティリティ --- */
  let volatility: Regime["volatility"] = "normal";
  const vix = ctx.get("^VIX");
  if (vix) {
    const level = vix.price.last;
    const pos = vix.price.rangePosition52w;
    volatility =
      level >= 30 ? "stress" : level >= 20 ? "elevated" : level <= 14 ? "low" : "normal";
    evidence.push({
      name: "VIX",
      value: level,
      reading: `${level.toFixed(1)} (52週レンジ内 ${isNum(pos) ? (pos * 100).toFixed(0) : "?"}%) — ${
        volatility === "stress"
          ? "ストレス"
          : volatility === "elevated"
            ? "警戒水準"
            : volatility === "low"
              ? "低位安定"
              : "平常"
      }`,
    });
  } else {
    const v = spx.risk.volRatio;
    if (isNum(v)) {
      volatility = v >= 1.6 ? "stress" : v >= 1.2 ? "elevated" : v <= 0.8 ? "low" : "normal";
      evidence.push({
        name: "S&P500 ボラ比 (20日/252日)",
        value: v,
        reading: `${v.toFixed(2)} — VIX が取れなかったため実現ボラで代用`,
      });
    }
  }

  /* --- リスク選好 --- */
  let riskScore = 0;
  const hyg = ctx.get("HYG");
  const lqd = ctx.get("LQD");
  const creditSpread = spread(hyg?.price.r3m, lqd?.price.r3m);
  if (creditSpread !== null) {
    riskScore += creditSpread > 0.005 ? 1 : creditSpread < -0.005 ? -1 : 0;
    evidence.push({
      name: "信用スプレッド代理 (HYG − LQD, 3ヶ月)",
      value: round(creditSpread, 4),
      reading: `${(creditSpread * 100).toFixed(2)}pt — ハイイールドが投資適格に${creditSpread >= 0 ? "優位 (リスク選好)" : "劣後 (信用不安)"}`,
    });
  }
  const copper = ctx.get("HG=F");
  const gold = ctx.get("GC=F");
  const cg = spread(copper?.price.r3m, gold?.price.r3m);
  if (cg !== null) {
    riskScore += cg > 0.02 ? 1 : cg < -0.02 ? -1 : 0;
    evidence.push({
      name: "銅 / 金 (3ヶ月リターン差)",
      value: round(cg, 4),
      reading: `${(cg * 100).toFixed(1)}pt — 実需 (銅) が退避 (金) に${cg >= 0 ? "勝っている" : "負けている"}`,
    });
  }
  const rut = ctx.get("^RUT");
  const smallLarge = spread(rut?.price.r3m, spx.price.r3m);
  if (smallLarge !== null) {
    riskScore += smallLarge > 0.01 ? 0.7 : smallLarge < -0.01 ? -0.7 : 0;
    evidence.push({
      name: "小型 / 大型 (ラッセル2000 − S&P500, 3ヶ月)",
      value: round(smallLarge, 4),
      reading: `${(smallLarge * 100).toFixed(1)}pt — 小型株が${smallLarge >= 0 ? "優位" : "劣後"}`,
    });
  }
  const tnx = ctx.get("^TNX");
  if (tnx) {
    evidence.push({
      name: "米10年金利",
      value: tnx.price.last,
      reading: `${tnx.price.last.toFixed(2)}% (1ヶ月 ${isNum(tnx.price.r1m) ? (tnx.price.r1m! * 100).toFixed(1) : "?"}%) — 金利は${isNum(tnx.price.r1m) && tnx.price.r1m! > 0 ? "上昇" : "低下"}方向`,
    });
  }
  const dxy = ctx.get("DX-Y.NYB");
  if (dxy && isNum(dxy.price.r3m)) {
    riskScore += dxy.price.r3m! > 0.03 ? -0.5 : dxy.price.r3m! < -0.03 ? 0.5 : 0;
    evidence.push({
      name: "ドル指数 (3ヶ月)",
      value: round(dxy.price.r3m, 4),
      reading: `${(dxy.price.r3m! * 100).toFixed(1)}% — ドル${dxy.price.r3m! > 0 ? "高 (新興国・商品に逆風)" : "安 (リスク資産に追い風)"}`,
    });
  }

  const riskAppetite: Regime["riskAppetite"] =
    riskScore >= 1 ? "risk-on" : riskScore <= -1 ? "risk-off" : "neutral";

  /* --- プレイブック --- */
  const playbook: string[] = [];
  if (trend === "bull" && riskAppetite === "risk-on") {
    playbook.push("順張りが機能しやすい地形。モメンタム上位・200日線上の銘柄を軸に。");
    playbook.push("バリュエーションの割高さは短期では効きにくい。撤退ルールを価格 (移動平均割れ) で持つ。");
  } else if (trend === "bull" && riskAppetite !== "risk-on") {
    playbook.push("指数は上だが裾野が弱い。クオリティ (高ROE・低負債) に寄せ、低流動性の小型は避ける。");
  } else if (trend === "bear") {
    playbook.push("下降基調。押し目買いより戻り売られの確認を優先。現金比率が最大のポジション。");
    playbook.push("低ボラ・ディフェンシブ (生活必需品/公益/ヘルスケア) の相対優位が出やすい。");
  } else {
    playbook.push("レンジ地形。ブレイクアウトは騙されやすい。支持帯・抵抗帯での逆張りが相対的に有利。");
  }
  if (volatility === "stress") {
    playbook.push("ボラがストレス水準。ポジションサイズを ATR 基準で機械的に縮小する局面。");
  } else if (volatility === "low") {
    playbook.push("低ボラ環境。ボリンジャーのスクイーズ銘柄は放れの初動を取りやすい。");
  }
  if (breadth && (breadth.label === "narrow-rally" || breadth.label === "narrow-selloff")) {
    playbook.push("上昇/下落が一部銘柄に偏っている。指数の見た目より個別のばらつきが大きい。");
  }

  return {
    asOf: new Date().toISOString(),
    trend,
    trendConfidence,
    volatility,
    riskAppetite,
    evidence,
    playbook,
  };
}
