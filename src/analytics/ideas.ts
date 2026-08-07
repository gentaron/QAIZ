import type {
  Idea,
  IdeaBook,
  InstrumentRecord,
  PlaybookId,
  Regime,
} from "../types.ts";
import { SECTOR_META } from "../config/sectors.ts";
import { isNum, round } from "./stats.ts";

/**
 * 銘柄アイデアの生成。
 *
 * 設計の 3 原則:
 *
 * 1. **レジーム条件付き**。同じ銘柄でも、上昇基調とストレス局面では
 *    候補として出すべきかが変わる。まず「今どの戦術が機能しやすい地形か」を
 *    決め、その戦術に合う銘柄だけを探す。全部の戦術を常時回すと、
 *    どんな相場でも必ず何か推してしまう装置になる。
 *
 * 2. **根拠は必ず実数**。「モメンタムが強い」ではなく
 *    「12-1モメンタム +23%、200日線から +17%」と書く。
 *    数字を書けないものは根拠として採用しない。
 *
 * 3. **反証を必ず添える**。何が起きたらこの見立てが崩れるかを書けない
 *    アイデアは出さない。これが無いものは推奨であって分析ではない。
 *
 * 出力は「候補と根拠」であって売買推奨ではない。IdeaBook.disclaimer に明記する。
 */

const DISCLAIMER =
  "これは投資助言ではありません。ルールベースで抽出した候補と、その根拠・反証材料です。" +
  "データは非公式APIに由来し、正確性は保証されません。最終判断はご自身で行ってください。";

interface PlaybookDef {
  id: PlaybookId;
  nameJa: string;
  /** 初心者向け: 何を狙う戦術か */
  plain: string;
  /** この戦術が機能しやすいレジーム。合致したら有効化する */
  fits: (r: Regime | null) => { active: boolean; why: string };
  /** 候補になれるか (足切り) */
  eligible: (rec: InstrumentRecord) => boolean;
  /** 素点。高いほど上位 */
  score: (rec: InstrumentRecord) => number | null;
  /** 根拠。数値を伴う文だけを返す */
  thesis: (rec: InstrumentRecord) => string[];
  /** 表に出す主要数値 */
  evidence: (rec: InstrumentRecord) => { label: string; value: string; glossary?: string }[];
}

/* ------------------------------------------------------------------ */
/* 表示ヘルパー                                                        */
/* ------------------------------------------------------------------ */

const pct = (x: number | null | undefined, d = 1): string =>
  isNum(x) ? `${x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—";
const pctAbs = (x: number | null | undefined, d = 1): string =>
  isNum(x) ? `${(x * 100).toFixed(d)}%` : "—";
const mult = (x: number | null | undefined, d = 1): string =>
  isNum(x) ? `${x.toFixed(d)}倍` : "—";
const num = (x: number | null | undefined, d = 1): string => (isNum(x) ? x.toFixed(d) : "—");

const f = (rec: InstrumentRecord) => rec.fundamentals;
const fx = (rec: InstrumentRecord) => rec.factors;

/* ------------------------------------------------------------------ */
/* プレイブック定義                                                    */
/* ------------------------------------------------------------------ */

const PLAYBOOKS: PlaybookDef[] = [
  {
    id: "momentum-quality",
    nameJa: "クオリティ × モメンタム",
    plain:
      "「稼ぐ力が強くて、かつ株価も上向きの会社」を買う戦術。実証研究でいちばん頑健とされる組み合わせ。上昇相場で機能しやすい反面、相場が転換すると真っ先に売られる。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend === "bull" && r.volatility !== "stress";
      return {
        active,
        why: active
          ? "上昇基調でボラも落ち着いており、順張りが機能しやすい地形"
          : "上昇基調でないか、ボラがストレス水準。順張りは騙されやすい",
      };
    },
    eligible: (rec) =>
      rec.instrument.role === "constituent" &&
      rec.technicals.ma.above.sma200 === true &&
      isNum(fx(rec)?.quality) &&
      fx(rec)!.quality! >= 60 &&
      isNum(rec.price.r12m1m) &&
      rec.price.r12m1m! > 0,
    score: (rec) => {
      const q = fx(rec)?.quality;
      const m = fx(rec)?.momentum;
      return isNum(q) && isNum(m) ? q * 0.5 + m * 0.5 : null;
    },
    thesis: (rec) => {
      const out: string[] = [];
      const fu = f(rec);
      if (isNum(fu?.returnOnEquity))
        out.push(
          `ROE ${pctAbs(fu!.returnOnEquity)} — 株主資本を効率よく利益に変えている` +
            (isNum(fu!.debtToEquity) ? ` (D/E ${num(fu!.debtToEquity, 0)}% なので借金による嵩上げではない)` : "")
        );
      if (isNum(rec.price.r12m1m))
        out.push(
          `12-1モメンタム ${pct(rec.price.r12m1m)} — 直近1ヶ月を除いた1年のリターン。短期の反動を除いた実力ベースで上昇`
        );
      if (isNum(rec.technicals.ma.deviation200))
        out.push(`200日線から ${pct(rec.technicals.ma.deviation200)} 上 — 中期トレンドが上向き`);
      if (isNum(fu?.operatingMargin))
        out.push(`営業利益率 ${pctAbs(fu!.operatingMargin)} — 価格決定力があり、値下げ圧力に強い`);
      if (rec.technicals.adx?.regime === "trending")
        out.push(
          `ADX ${num(rec.technicals.adx.adx)} — 方向性のあるトレンドが出ている (+DI ${num(rec.technicals.adx.plusDi)} / -DI ${num(rec.technicals.adx.minusDi)})`
        );
      return out;
    },
    evidence: (rec) => [
      { label: "ROE", value: pctAbs(f(rec)?.returnOnEquity), glossary: "returnOnEquity" },
      { label: "12-1モメンタム", value: pct(rec.price.r12m1m), glossary: "factorMomentum" },
      { label: "予想PER", value: mult(f(rec)?.forwardPE), glossary: "forwardPE" },
      { label: "質スコア", value: num(fx(rec)?.quality, 0), glossary: "factorComposite" },
    ],
  },

  {
    id: "value-recovery",
    nameJa: "割安 × 底打ち確認",
    plain:
      "「安く放置されているが、下げ止まりの兆しが出ている会社」を拾う戦術。安いだけの銘柄を買うと下がり続けるので、価格が底を打った証拠を必ず条件にする。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend !== "bear" || r.riskAppetite !== "risk-off";
      return {
        active,
        why: active
          ? "総崩れではないため、個別の割安が見直される余地がある"
          : "下降基調かつリスクオフ。割安は更に割安になりやすい局面",
      };
    },
    eligible: (rec) =>
      rec.instrument.role === "constituent" &&
      isNum(fx(rec)?.value) &&
      fx(rec)!.value! >= 65 &&
      isNum(f(rec)?.operatingMargin) &&
      f(rec)!.operatingMargin! > 0 &&
      // 底打ちの証拠: 50日線の上か、RSIが売られすぎから戻っている
      (rec.technicals.ma.above.sma50 === true ||
        (isNum(rec.technicals.rsi14) && rec.technicals.rsi14! > 40)),
    score: (rec) => {
      const v = fx(rec)?.value;
      const q = fx(rec)?.quality;
      return isNum(v) ? v * 0.7 + (isNum(q) ? q * 0.3 : 15) : null;
    },
    thesis: (rec) => {
      const out: string[] = [];
      const fu = f(rec);
      const sectorJa = SECTOR_META[rec.instrument.sector]?.nameJa ?? rec.instrument.sector;
      const vm = rec.valuation?.metrics.find((m) => m.key === "forwardPE");
      if (vm && isNum(vm.value) && isNum(vm.peerMedian))
        out.push(
          `予想PER ${mult(vm.value)} — 同じ「${sectorJa}」の中央値 ${mult(vm.peerMedian)} を下回る (セクター内で下位${isNum(vm.percentile) ? (100 - vm.percentile).toFixed(0) : "?"}%の水準)`
        );
      if (isNum(fu?.priceToBook) && fu!.priceToBook! < 1.5)
        out.push(`PBR ${mult(fu!.priceToBook, 2)} — 解散価値に近い水準`);
      if (isNum(fu?.fcfYield) && fu!.fcfYield! > 0.04)
        out.push(`FCF利回り ${pctAbs(fu!.fcfYield)} — 会計上の利益ではなく現金の裏付けがある割安さ`);
      if (isNum(fu?.operatingMargin))
        out.push(`営業利益率 ${pctAbs(fu!.operatingMargin)} — 黒字を維持しており、安いのは業績崩壊が理由ではない`);
      if (rec.technicals.ma.above.sma50 === true)
        out.push(`50日線を回復 — 下げ止まりの初期サイン`);
      if (isNum(rec.consensus?.upsideToTarget) && rec.consensus!.upsideToTarget! > 0.15)
        out.push(
          `アナリスト平均目標まで ${pct(rec.consensus!.upsideToTarget, 0)} (${rec.consensus!.analystCount ?? "?"}名)`
        );
      return out;
    },
    evidence: (rec) => [
      { label: "予想PER", value: mult(f(rec)?.forwardPE), glossary: "forwardPE" },
      { label: "PBR", value: mult(f(rec)?.priceToBook, 2), glossary: "priceToBook" },
      { label: "ROE", value: pctAbs(f(rec)?.returnOnEquity), glossary: "returnOnEquity" },
      { label: "割安スコア", value: num(fx(rec)?.value, 0), glossary: "factorValue" },
    ],
  },

  {
    id: "defensive-rotation",
    nameJa: "ディフェンシブ退避",
    plain:
      "景気が悪くなっても需要が落ちにくい業種 (生活必需品・公益・ヘルスケア) に資金を移す戦術。上がることを狙うのではなく、下げを浅くすることを狙う。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend === "bear" || r.volatility === "stress" || r.riskAppetite === "risk-off";
      return {
        active,
        why: active
          ? "下降基調・高ボラ・リスクオフのいずれかに該当。守りの相対優位が出やすい"
          : "リスクを取れる地形。ディフェンシブは相対的に劣後しやすい",
      };
    },
    eligible: (rec) =>
      ["staples", "utilities", "health"].includes(rec.instrument.sector) &&
      isNum(rec.risk.vol252) &&
      rec.risk.vol252! <= 0.32 &&
      isNum(fx(rec)?.lowVol) &&
      fx(rec)!.lowVol! >= 50,
    score: (rec) => {
      const lv = fx(rec)?.lowVol;
      const q = fx(rec)?.quality;
      return isNum(lv) ? lv * 0.6 + (isNum(q) ? q * 0.4 : 20) : null;
    },
    thesis: (rec) => {
      const out: string[] = [];
      const sectorJa = SECTOR_META[rec.instrument.sector]?.nameJa ?? rec.instrument.sector;
      out.push(`${sectorJa} — 景気に左右されにくい需要を持つ業種`);
      if (isNum(rec.risk.vol252))
        out.push(`年率ボラ ${pctAbs(rec.risk.vol252, 0)} — 値動きが穏やか`);
      if (isNum(rec.risk.beta))
        out.push(
          `β ${num(rec.risk.beta, 2)} — 市場が10%下げたとき ${(rec.risk.beta! * 10).toFixed(0)}% 程度の下落に留まる傾向`
        );
      if (isNum(rec.risk.downCapture))
        out.push(`下落キャプチャ ${num(rec.risk.downCapture, 2)} — 下げ相場での追随度合い`);
      if (isNum(rec.risk.maxDrawdown))
        out.push(`過去最大ドローダウン ${pct(rec.risk.maxDrawdown, 0)}`);
      if (isNum(f(rec)?.dividendYield) && f(rec)!.dividendYield! > 0.02)
        out.push(`配当利回り ${pctAbs(f(rec)!.dividendYield, 2)} — 値上がりを待つ間の下支え`);
      return out;
    },
    evidence: (rec) => [
      { label: "年率ボラ", value: pctAbs(rec.risk.vol252, 0), glossary: "vol252" },
      { label: "β", value: num(rec.risk.beta, 2), glossary: "beta" },
      { label: "最大DD", value: pct(rec.risk.maxDrawdown, 0), glossary: "maxDrawdown" },
      { label: "配当", value: pctAbs(f(rec)?.dividendYield, 2), glossary: "dividendYield" },
    ],
  },

  {
    id: "contrarian-oversold",
    nameJa: "押し目のクオリティ株",
    plain:
      "「中長期のトレンドは生きているのに、短期的に売られすぎた優良株」を拾う戦術。上昇トレンドの銘柄が一時的に下げたところを狙う。下降トレンドの銘柄を拾うのとは根本的に違う。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend !== "bear";
      return {
        active,
        why: active
          ? "総崩れではないため、押し目が押し目として機能しやすい"
          : "下降基調では「押し目」がそのまま下落の途中になりやすい",
      };
    },
    eligible: (rec) =>
      rec.instrument.role === "constituent" &&
      rec.technicals.ma.above.sma200 === true &&
      isNum(rec.technicals.rsi14) &&
      rec.technicals.rsi14! <= 45 &&
      isNum(f(rec)?.returnOnEquity) &&
      f(rec)!.returnOnEquity! >= 0.1,
    score: (rec) => {
      const rsi = rec.technicals.rsi14;
      const q = fx(rec)?.quality;
      // RSI が低いほど、かつ質が高いほど良い
      return isNum(rsi) && isNum(q) ? (50 - rsi) * 2 + q * 0.6 : null;
    },
    thesis: (rec) => {
      const out: string[] = [];
      out.push(
        `RSI ${num(rec.technicals.rsi14)} — 短期的に売られすぎの水準まで下げている`
      );
      if (isNum(rec.technicals.ma.deviation200))
        out.push(
          `ただし200日線は ${pct(rec.technicals.ma.deviation200)} 上 — 中期の上昇トレンド自体は崩れていない`
        );
      if (isNum(f(rec)?.returnOnEquity))
        out.push(`ROE ${pctAbs(f(rec)!.returnOnEquity)} — 業績の質は維持されている`);
      if (isNum(rec.price.drawdownFrom52wHigh))
        out.push(`52週高値から ${pct(rec.price.drawdownFrom52wHigh)} — 押し目の深さ`);
      const sup = rec.technicals.levels.support[0];
      if (sup)
        out.push(
          `直下 ${pct(sup.distancePct)} に支持帯 ${sup.level} (過去${sup.touches}回反応) — 撤退ラインを引きやすい`
        );
      if (rec.technicals.rsiDivergence === "bullish")
        out.push("RSIに強気ダイバージェンス — 下げの勢いが減衰している");
      return out;
    },
    evidence: (rec) => [
      { label: "RSI", value: num(rec.technicals.rsi14), glossary: "rsi14" },
      { label: "200日線乖離", value: pct(rec.technicals.ma.deviation200), glossary: "compositeScore" },
      { label: "高値から", value: pct(rec.price.drawdownFrom52wHigh), glossary: "rangePosition52w" },
      { label: "ROE", value: pctAbs(f(rec)?.returnOnEquity), glossary: "returnOnEquity" },
    ],
  },

  {
    id: "breakout",
    nameJa: "ブレイクアウト",
    plain:
      "「1年の高値圏に到達し、勢いも出来高も伴っている銘柄」を狙う戦術。高いところを買うので怖く感じるが、高値更新銘柄はその後も上がりやすいという実証がある。ただし外れたときの損切りは早くする必要がある。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend === "bull" && r.volatility !== "stress";
      return {
        active,
        why: active
          ? "上昇基調。ブレイクアウトが騙しになりにくい"
          : "レンジまたは高ボラ。ブレイクアウトは騙されやすく、往って来いになりやすい",
      };
    },
    eligible: (rec) =>
      isNum(rec.price.rangePosition52w) &&
      rec.price.rangePosition52w! >= 0.85 &&
      rec.technicals.adx !== null &&
      rec.technicals.adx.adx >= 22 &&
      rec.technicals.adx.direction === "up",
    score: (rec) => {
      const rp = rec.price.rangePosition52w;
      const adx = rec.technicals.adx?.adx;
      const vr = rec.price.volumeRatio;
      if (!isNum(rp) || !isNum(adx)) return null;
      return rp * 50 + adx + (isNum(vr) ? Math.min(20, vr * 8) : 0);
    },
    thesis: (rec) => {
      const out: string[] = [];
      out.push(
        `52週レンジの上位 ${(rec.price.rangePosition52w! * 100).toFixed(0)}% — 高値圏に到達`
      );
      if (rec.technicals.adx)
        out.push(
          `ADX ${num(rec.technicals.adx.adx)} で上向き (+DI ${num(rec.technicals.adx.plusDi)} > -DI ${num(rec.technicals.adx.minusDi)}) — 方向性のあるトレンド`
        );
      if (isNum(rec.price.volumeRatio))
        out.push(
          `出来高は20日平均の ${num(rec.price.volumeRatio, 2)}倍 — 値動きに需給が伴っている`
        );
      if (rec.technicals.ma.perfectOrder === "bullish")
        out.push("移動平均が5/20/50/200の順に整列 (パーフェクトオーダー)");
      const res = rec.technicals.levels.resistance[0];
      if (res) out.push(`直上 ${pct(res.distancePct)} に抵抗帯 ${res.level} (過去${res.touches}回反落) — ここを抜けるかが分岐点`);
      return out;
    },
    evidence: (rec) => [
      { label: "レンジ位置", value: `${((rec.price.rangePosition52w ?? 0) * 100).toFixed(0)}%`, glossary: "rangePosition52w" },
      { label: "ADX", value: num(rec.technicals.adx?.adx), glossary: "adx" },
      { label: "出来高比", value: `${num(rec.price.volumeRatio, 2)}x` },
      { label: "ATR%", value: pctAbs(rec.technicals.atrPercent, 2), glossary: "atrPercent" },
    ],
  },

  {
    id: "dividend-income",
    nameJa: "高配当 × 配当余力",
    plain:
      "配当をもらい続けることを狙う戦術。利回りの高さだけで選ぶと減配銘柄を掴むので、配当を払う余力 (配当性向と財務) を必ず確認する。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend !== "bull" || r.riskAppetite !== "risk-on";
      return {
        active,
        why: active
          ? "値上がり益を狙いにくい地形。インカムの相対的な価値が上がる"
          : "強い上昇基調。配当より値上がり益のほうが効率が良い局面",
      };
    },
    eligible: (rec) =>
      isNum(f(rec)?.dividendYield) &&
      f(rec)!.dividendYield! >= 0.025 &&
      isNum(f(rec)?.payoutRatio) &&
      f(rec)!.payoutRatio! > 0 &&
      f(rec)!.payoutRatio! <= 0.75 &&
      (!isNum(f(rec)?.debtToEquity) || f(rec)!.debtToEquity! <= 200),
    score: (rec) => {
      const dy = f(rec)?.dividendYield;
      const pr = f(rec)?.payoutRatio;
      if (!isNum(dy)) return null;
      // 利回りが高く、配当性向に余裕があるほど良い
      return dy * 800 + (isNum(pr) ? (0.75 - pr) * 60 : 0);
    },
    thesis: (rec) => {
      const out: string[] = [];
      const fu = f(rec)!;
      out.push(`配当利回り ${pctAbs(fu.dividendYield, 2)}`);
      if (isNum(fu.payoutRatio))
        out.push(
          `配当性向 ${pctAbs(fu.payoutRatio, 0)} — 利益の${(fu.payoutRatio! * 100).toFixed(0)}%を配当に回しており、残りが減配のバッファになる`
        );
      if (isNum(fu.debtToEquity))
        out.push(`D/E ${num(fu.debtToEquity, 0)}% — 財務に配当を続ける余力がある`);
      if (isNum(fu.freeCashflowValue) && isNum(fu.marketCap) && fu.marketCap! > 0)
        out.push(`FCF利回り ${pctAbs(fu.freeCashflowValue! / fu.marketCap!, 1)} — 現金の裏付け`);
      if (isNum(rec.risk.vol252))
        out.push(`年率ボラ ${pctAbs(rec.risk.vol252, 0)} — 配当を待つ間の値動き`);
      return out;
    },
    evidence: (rec) => [
      { label: "配当利回り", value: pctAbs(f(rec)?.dividendYield, 2), glossary: "dividendYield" },
      { label: "配当性向", value: pctAbs(f(rec)?.payoutRatio, 0), glossary: "payoutRatio" },
      { label: "D/E", value: `${num(f(rec)?.debtToEquity, 0)}%`, glossary: "debtToEquity" },
      { label: "年率ボラ", value: pctAbs(rec.risk.vol252, 0), glossary: "vol252" },
    ],
  },

  {
    id: "mean-reversion",
    nameJa: "レンジの逆張り",
    plain:
      "方向感のない相場で、支持帯まで下げたところを買い、抵抗帯で利益確定する戦術。トレンドが無いことが前提なので、トレンドが出たら成立しなくなる。",
    fits: (r) => {
      if (!r) return { active: false, why: "レジーム判定が取れていない" };
      const active = r.trend === "range";
      return {
        active,
        why: active
          ? "方向感のないレンジ地形。ブレイクアウトより往復の逆張りが有利"
          : "トレンドが出ている。逆張りは踏まれやすい",
      };
    },
    eligible: (rec) =>
      rec.technicals.adx !== null &&
      rec.technicals.adx.adx < 22 &&
      rec.technicals.levels.support.length > 0 &&
      isNum(rec.technicals.levels.support[0].distancePct) &&
      rec.technicals.levels.support[0].distancePct > -0.06,
    score: (rec) => {
      const sup = rec.technicals.levels.support[0];
      const rsi = rec.technicals.rsi14;
      if (!sup) return null;
      // 支持帯に近く、タッチ回数が多く、RSIが低いほど良い
      return sup.touches * 12 + (1 + sup.distancePct) * 40 + (isNum(rsi) ? 50 - rsi : 0);
    },
    thesis: (rec) => {
      const out: string[] = [];
      const sup = rec.technicals.levels.support[0];
      const res = rec.technicals.levels.resistance[0];
      out.push(`ADX ${num(rec.technicals.adx?.adx)} — 22未満で方向感がなく、レンジとして扱える`);
      if (sup)
        out.push(
          `直下 ${pct(sup.distancePct)} の ${sup.level} に支持帯 — 過去${sup.touches}回反発しており、割れたら撤退という線を引ける`
        );
      if (res)
        out.push(`上値は ${pct(res.distancePct)} の ${res.level} — ここが利益確定の目安`);
      if (sup && res)
        out.push(
          `想定できる往復幅は約 ${((res.distancePct - sup.distancePct) * 100).toFixed(1)}pt`
        );
      if (isNum(rec.technicals.rsi14))
        out.push(`RSI ${num(rec.technicals.rsi14)}`);
      return out;
    },
    evidence: (rec) => [
      { label: "ADX", value: num(rec.technicals.adx?.adx), glossary: "adx" },
      { label: "支持帯まで", value: pct(rec.technicals.levels.support[0]?.distancePct) },
      { label: "抵抗帯まで", value: pct(rec.technicals.levels.resistance[0]?.distancePct) },
      { label: "RSI", value: num(rec.technicals.rsi14), glossary: "rsi14" },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* リスク (反証材料) の抽出                                            */
/* ------------------------------------------------------------------ */

/**
 * 何が起きたらこの見立てが崩れるか。
 *
 * プレイブック固有の前提が壊れる条件 + 銘柄固有の弱点 を並べる。
 * 1 本も書けないアイデアは出さない (呼び出し側で弾く)。
 */
function buildRisks(rec: InstrumentRecord, pb: PlaybookDef): string[] {
  const out: string[] = [];
  const fu = f(rec);

  // --- プレイブック固有の前提 ---
  switch (pb.id) {
    case "momentum-quality":
      if (isNum(rec.technicals.ma.sma200))
        out.push(
          `200日線 (${num(rec.technicals.ma.sma200, 2)}) を割ると順張りの前提が崩れる。ここが機械的な撤退ラインになる`
        );
      out.push("モメンタム戦略は相場の転換点で最も大きくやられる。指数が下落基調に変わったら真っ先に外す対象");
      break;
    case "value-recovery":
      out.push("割安が解消されないまま時間だけ過ぎる「バリュートラップ」の可能性。次の決算で業績の底打ちが確認できるかが分岐点");
      if (isNum(fu?.returnOnEquity) && fu!.returnOnEquity! < 0.1)
        out.push(`ROE ${pctAbs(fu!.returnOnEquity)} と低め。資本効率が改善しなければ安いままの状態が続きやすい`);
      break;
    case "defensive-rotation":
      out.push("金利が急上昇すると、配当利回りの相対的な魅力が落ちてディフェンシブも売られる");
      out.push("相場が上昇に転じると、守りに寄せたぶん取り残される (下げに強い = 上げに弱い)");
      break;
    case "contrarian-oversold":
      out.push("押し目と下落トレンドの初動は途中まで区別がつかない。200日線を明確に割ったら前提が変わる");
      if (rec.technicals.rsiDivergence === "bearish")
        out.push("RSIに弱気ダイバージェンスが出ており、上げの勢い自体が落ちている");
      break;
    case "breakout":
      out.push("高値圏で買うため、外れたときの下落余地が大きい。ブレイクが失敗して元のレンジに戻る「往って来い」が典型的な失敗パターン");
      if (isNum(rec.technicals.atrPercent))
        out.push(
          `ATR% ${pctAbs(rec.technicals.atrPercent, 2)} — 1日の平均値幅。損切り幅はこれの2〜3倍を見ておく必要がある`
        );
      break;
    case "dividend-income":
      out.push("減配リスク。業績が悪化して配当性向が100%に近づくと、配当そのものが維持できなくなる");
      out.push("株価下落による損失が配当収入を上回ることは普通にある。利回りは下落の保険ではない");
      break;
    case "mean-reversion":
      out.push("レンジを上下どちらかに放れたら戦術自体が成立しない。ADXが25を超えてきたら手仕舞いの合図");
      break;
  }

  // --- 銘柄固有の弱点 ---
  if (isNum(fu?.forwardPE)) {
    const vm = rec.valuation?.metrics.find((m) => m.key === "forwardPE");
    if (vm && isNum(vm.percentile) && vm.percentile <= 20)
      out.push(
        `予想PER ${mult(fu!.forwardPE)} はセクター内で割高な部類 (中央値 ${mult(vm.peerMedian)})。成長が続く前提が既に価格に入っている`
      );
  }
  if (isNum(rec.risk.beta) && rec.risk.beta! >= 1.4)
    out.push(`β ${num(rec.risk.beta, 2)} — 市場が下げるとき増幅される`);
  if (isNum(rec.risk.volRatio) && rec.risk.volRatio! >= 1.4)
    out.push(`直近20日のボラが1年平均の ${num(rec.risk.volRatio, 2)}倍 に拡大中。同じ株数でもリスク量が増えている`);
  if (isNum(rec.risk.cvar95))
    out.push(`悪い日の平均下落 (CVaR95%) は日次 ${pctAbs(rec.risk.cvar95, 2)}`);
  if (isNum(fu?.netDebtToEbitda) && fu!.netDebtToEbitda! >= 4)
    out.push(`ネット有利子負債/EBITDA ${num(fu!.netDebtToEbitda)}倍 — 金利上昇で利払いが利益を圧迫する`);
  if (isNum(rec.consensus?.upsideToTarget) && rec.consensus!.upsideToTarget! < 0)
    out.push(
      `アナリスト平均目標を既に ${pct(-rec.consensus!.upsideToTarget!, 0)} 上回っている。目標が引き上げられなければ格下げ余地`
    );
  if (rec.dataQuality.warnings.length > 0)
    out.push(`データ上の注意: ${rec.dataQuality.warnings[0]}`);

  return out;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                */
/* ------------------------------------------------------------------ */

export interface IdeaOptions {
  /** 1 戦術あたりの最大候補数 */
  perPlaybook?: number;
  /** 全体の最大件数 */
  limit?: number;
  /** 地域で絞る */
  regions?: string[];
}

export function generateIdeas(
  records: Record<string, InstrumentRecord>,
  regime: Regime | null,
  opts: IdeaOptions = {}
): IdeaBook {
  const perPlaybook = opts.perPlaybook ?? 3;
  const limit = opts.limit ?? 18;

  let pool = Object.values(records).filter(
    (r) => r.instrument.role === "constituent" || r.instrument.role === "sector-proxy"
  );
  if (opts.regions?.length) {
    const set = new Set(opts.regions);
    pool = pool.filter((r) => set.has(r.instrument.region));
  }

  const active = PLAYBOOKS.map((pb) => ({ pb, fit: pb.fits(regime) })).filter((x) => x.fit.active);

  const ideas: Idea[] = [];
  for (const { pb, fit } of active) {
    const candidates = pool
      .filter((r) => {
        try {
          return pb.eligible(r);
        } catch {
          return false;
        }
      })
      .map((r) => ({ r, s: pb.score(r) }))
      .filter((x): x is { r: InstrumentRecord; s: number } => isNum(x.s))
      .sort((a, b) => b.s - a.s);

    for (const { r, s } of candidates.slice(0, perPlaybook)) {
      const thesis = pb.thesis(r).filter((t) => t.length > 0);
      const risks = buildRisks(r, pb);
      // 根拠が薄いもの、反証が書けないものは候補にしない。
      // 「なんとなく条件に合った」だけの銘柄を並べると、
      // 全体が占いに見えてしまう。
      if (thesis.length < 3 || risks.length < 2) continue;

      const conviction: 1 | 2 | 3 = thesis.length >= 5 && risks.length <= 4 ? 3 : thesis.length >= 4 ? 2 : 1;

      ideas.push({
        id: `${pb.id}:${r.instrument.symbol}`,
        rank: 0,
        symbol: r.instrument.symbol,
        nameJa: r.instrument.nameJa,
        region: r.instrument.region,
        sector: r.instrument.sector,
        playbook: pb.id,
        playbookNameJa: pb.nameJa,
        headline: buildHeadline(r, pb),
        plain: pb.plain,
        thesis,
        risks,
        evidence: pb.evidence(r),
        conviction,
        score: round(s, 2)!,
        regimeFit: fit.why,
        related: (r.related ?? [])
          .filter((x) => x.kind === "sector-peer" || x.kind === "theme" || x.kind === "diversifier")
          .slice(0, 4),
      });
    }
  }

  // 確信度 → 素点の順に並べる。素点は戦術ごとに尺度が違うので、
  // 戦術を跨いだ厳密な比較にはしない (確信度を先に見る)
  ideas.sort((a, b) => b.conviction - a.conviction || b.score - a.score);
  const trimmed = ideas.slice(0, limit);
  trimmed.forEach((x, i) => (x.rank = i + 1));

  return {
    generatedAt: new Date().toISOString(),
    regime: regime
      ? { trend: regime.trend, volatility: regime.volatility, riskAppetite: regime.riskAppetite }
      : null,
    activePlaybooks: active.map(({ pb, fit }) => ({ id: pb.id, nameJa: pb.nameJa, why: fit.why })),
    ideas: trimmed,
    universeNote:
      `候補は QAIZ が追跡している ${pool.length} 銘柄の中から選んでいます。` +
      "市場全体をスクリーニングしたものではないため、ここに出ないより良い銘柄は当然あります。",
    disclaimer: DISCLAIMER,
  };
}

function buildHeadline(rec: InstrumentRecord, pb: PlaybookDef): string {
  const sectorJa = SECTOR_META[rec.instrument.sector]?.nameJa ?? rec.instrument.sector;
  switch (pb.id) {
    case "momentum-quality":
      return `${sectorJa}の高ROE銘柄。トレンドが生きたまま業績の質も伴っている`;
    case "value-recovery":
      return `同業比で割安。黒字を保ったまま下げ止まりの兆しが出ている`;
    case "defensive-rotation":
      return `${sectorJa}。値動きが穏やかで、下げ相場での目減りを抑えたいときの候補`;
    case "contrarian-oversold":
      return `上昇トレンドは維持したまま、短期的に売られすぎた水準`;
    case "breakout":
      return `52週高値圏で、トレンドの強さと出来高が伴っている`;
    case "dividend-income":
      return `配当利回りが高く、配当を続ける余力も確認できる`;
    case "mean-reversion":
      return `方向感のないレンジの下限付近。支持帯を撤退ラインにできる`;
  }
}

export { PLAYBOOKS };
