import type { Bar, Momentum } from "../types";

/** 終値列から対数リターン列を得る */
export function logReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i - 1].c > 0 && bars[i].c > 0) {
      out.push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }
  return out;
}

function periodReturn(bars: Bar[], days: number): number {
  if (bars.length < days + 1) return 0;
  const last = bars[bars.length - 1].c;
  const prev = bars[bars.length - 1 - days].c;
  return prev > 0 ? last / prev - 1 : 0;
}

/** 年率換算ボラティリティ */
function annualizedVol(returns: number[]): number {
  if (returns.length < 5) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const varr =
    returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) /
    (returns.length - 1);
  return Math.sqrt(varr * 252);
}

export function computeMomentum(bars: Bar[]): Momentum {
  const returns = logReturns(bars);
  const r1w = periodReturn(bars, 5);
  const r1m = periodReturn(bars, 21);
  const r3m = periodReturn(bars, 63);

  const recent = returns.slice(-63);
  const vol = annualizedVol(recent);
  // 3ヶ月モメンタムのボラ調整 (簡易シャープ)
  const volAdj = vol > 1e-6 ? (r3m * 4) / vol : 0;

  const last21 = returns.slice(-21);
  const upDays = last21.filter((r) => r > 0).length;
  const trendConsistency = last21.length > 0 ? upDays / last21.length : 0.5;

  return { r1w, r1m, r3m, volAdj, trendConsistency };
}
