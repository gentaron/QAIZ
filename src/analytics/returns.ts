import type { Bar, PriceSummary } from "../types.ts";
import { isNum, mean, round } from "./stats.ts";

/** 対数リターン列 (リスク計測用。加法性があるので集計に向く) */
export function logReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c;
    const b = bars[i].c;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/** 単純リターン列 (VaR / ドローダウンなど「実際いくら減るか」の計測用) */
export function simpleReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c;
    if (a > 0) out.push(bars[i].c / a - 1);
  }
  return out;
}

/** n 営業日前からのリターン。データが足りなければ null */
export function periodReturn(bars: Bar[], days: number): number | null {
  if (bars.length < days + 1) return null;
  const last = bars[bars.length - 1].c;
  const prev = bars[bars.length - 1 - days].c;
  return prev > 0 ? last / prev - 1 : null;
}

/** 年初来リターン。年初をまたぐ最初のバーを基準にする */
export function ytdReturn(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const year = new Date(last.t * 1000).getUTCFullYear();
  // 今年に入って最初のバーの「1 本前」を基準にすると年末終値になる
  let firstIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (new Date(bars[i].t * 1000).getUTCFullYear() === year) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx <= 0) return null;
  const base = bars[firstIdx - 1].c;
  return base > 0 ? last.c / base - 1 : null;
}

/**
 * 12-1 モメンタム。直近 1 ヶ月を除いた 12 ヶ月リターン。
 * 短期リバーサル (直近 1 ヶ月の反動) を除くのが学術・実務の標準で、
 * これを外すと「先月急騰した銘柄」を掴みに行くだけの指標になる。
 */
export function momentum12m1m(bars: Bar[]): number | null {
  if (bars.length < 253) return null;
  const end = bars[bars.length - 1 - 21].c;
  const start = bars[bars.length - 1 - 252].c;
  return start > 0 ? end / start - 1 : null;
}

export function computePriceSummary(bars: Bar[], currency: string): PriceSummary {
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2].c : null;

  const win52 = bars.slice(-252);
  const highs = win52.map((b) => b.h).filter((x) => Number.isFinite(x));
  const lows = win52.map((b) => b.l).filter((x) => Number.isFinite(x));
  const high52w = highs.length > 0 ? Math.max(...highs) : null;
  const low52w = lows.length > 0 ? Math.min(...lows) : null;

  const rangePosition52w =
    high52w !== null && low52w !== null && high52w - low52w > 1e-12
      ? (last.c - low52w) / (high52w - low52w)
      : null;

  const vols = bars.slice(-20).map((b) => b.v).filter(isNum);
  const avgVolume20d = vols.length >= 5 ? mean(vols) : null;
  const volumeRatio =
    isNum(last.v) && isNum(avgVolume20d) && avgVolume20d > 0 ? last.v / avgVolume20d : null;

  return {
    last: round(last.c)!,
    previousClose: round(prev),
    r1d: round(periodReturn(bars, 1)),
    r1w: round(periodReturn(bars, 5)),
    r1m: round(periodReturn(bars, 21)),
    r3m: round(periodReturn(bars, 63)),
    r6m: round(periodReturn(bars, 126)),
    r12m: round(periodReturn(bars, 252)),
    ytd: round(ytdReturn(bars)),
    r12m1m: round(momentum12m1m(bars)),
    high52w: round(high52w),
    low52w: round(low52w),
    rangePosition52w: round(rangePosition52w, 3),
    drawdownFrom52wHigh:
      high52w !== null && high52w > 0 ? round(last.c / high52w - 1) : null,
    avgVolume20d: avgVolume20d === null ? null : Math.round(avgVolume20d),
    volumeRatio: round(volumeRatio, 3),
    currency,
  };
}

/**
 * 2 本の日次系列を「日付が一致する日だけ」で揃える。
 *
 * 米株と日本株、あるいは指数と ETF は営業日が違う。日付を見ずに
 * 末尾から n 本ずつ取ってβを計算すると、祝日のずれで系列が 1 日
 * 平行移動し、相関が構造的に過小評価される。
 */
export function alignByDate(
  a: Bar[],
  b: Bar[]
): { a: number[]; b: number[]; days: number } {
  const dayKey = (t: number) => Math.floor(t / 86400);
  const mapB = new Map<number, number>();
  for (const bar of b) mapB.set(dayKey(bar.t), bar.c);

  const pa: number[] = [];
  const pb: number[] = [];
  for (const bar of a) {
    const cb = mapB.get(dayKey(bar.t));
    if (cb !== undefined && bar.c > 0 && cb > 0) {
      pa.push(bar.c);
      pb.push(cb);
    }
  }
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < pa.length; i++) {
    ra.push(Math.log(pa[i] / pa[i - 1]));
    rb.push(Math.log(pb[i] / pb[i - 1]));
  }
  return { a: ra, b: rb, days: ra.length };
}
