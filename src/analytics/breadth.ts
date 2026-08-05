import type { Breadth, InstrumentRecord } from "../types.ts";
import { isNum, mean, round } from "./stats.ts";

/**
 * 市場の幅。
 *
 * 指数が上がっていても、上げているのが数銘柄だけなら質の悪い上昇。
 * 「200日線超えの銘柄比率」と「騰落レシオ」を並べれば、上昇が
 * 広いのか狭いのかが 1 行で分かる。
 */
export function computeBreadth(scope: string, records: InstrumentRecord[]): Breadth | null {
  const rs = records.filter((r) => r.instrument.role !== "macro");
  if (rs.length < 3) return null;

  const above50 = rs.map((r) => r.technicals.ma.above.sma50).filter((x): x is boolean => x !== null);
  const above200 = rs.map((r) => r.technicals.ma.above.sma200).filter((x): x is boolean => x !== null);
  const pct = (xs: boolean[]) =>
    xs.length === 0 ? null : round((xs.filter(Boolean).length / xs.length) * 100, 1);

  const advancers = rs.filter((r) => isNum(r.price.r1d) && r.price.r1d! > 0).length;
  const decliners = rs.filter((r) => isNum(r.price.r1d) && r.price.r1d! < 0).length;

  // 52 週高値/安値の判定は「レンジ内位置が端 2% 以内」で近似する。
  // 実際の新高値更新日を取るには日次の高値履歴が要るが、
  // 端に張り付いているかどうかで実務上の意味はほぼ同じ。
  const newHighs52w = rs.filter(
    (r) => isNum(r.price.rangePosition52w) && r.price.rangePosition52w! >= 0.98
  ).length;
  const newLows52w = rs.filter(
    (r) => isNum(r.price.rangePosition52w) && r.price.rangePosition52w! <= 0.02
  ).length;

  const meanRsi = mean(rs.map((r) => r.technicals.rsi14).filter(isNum));
  const p200 = pct(above200);
  const adRatio = decliners > 0 ? round(advancers / decliners, 2) : advancers > 0 ? 99 : null;

  let label: Breadth["label"] = "mixed";
  const upShare = advancers + decliners > 0 ? advancers / (advancers + decliners) : 0.5;
  if (upShare >= 0.65) label = p200 !== null && p200 >= 55 ? "broad-rally" : "narrow-rally";
  else if (upShare <= 0.35) label = p200 !== null && p200 <= 45 ? "broad-selloff" : "narrow-selloff";

  return {
    scope,
    count: rs.length,
    pctAbove50dma: pct(above50),
    pctAbove200dma: p200,
    advancers,
    decliners,
    advanceDeclineRatio: adRatio,
    newHighs52w,
    newLows52w,
    meanRsi: round(meanRsi, 1),
    label,
  };
}
