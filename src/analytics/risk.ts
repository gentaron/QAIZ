import type { Bar, RiskMetrics } from "../types.ts";
import { alignByDate, logReturns, simpleReturns } from "./returns.ts";
import {
  clean,
  correlation,
  isNum,
  kurtosis,
  linreg,
  mean,
  quantile,
  round,
  skewness,
  stdev,
} from "./stats.ts";

const TRADING_DAYS = 252;

/** 年率ボラティリティ。窓が足りなければ null */
export function annualizedVol(returns: number[], window?: number): number | null {
  const w = window ? returns.slice(-window) : returns;
  if (w.length < Math.max(5, Math.floor((window ?? 5) * 0.6))) return null;
  const sd = stdev(w);
  return sd === null ? null : sd * Math.sqrt(TRADING_DAYS);
}

/** 下方偏差 (目標リターン 0 以下の変動だけを測る) */
export function downsideDeviation(returns: number[], target = 0): number | null {
  const below = returns.filter((r) => r < target).map((r) => (r - target) ** 2);
  if (below.length < 5) return null;
  return Math.sqrt(below.reduce((a, b) => a + b, 0) / returns.length) * Math.sqrt(TRADING_DAYS);
}

/** 最大ドローダウン (負値)、その期間、現在のドローダウン */
export function drawdown(bars: Bar[]): {
  max: number | null;
  maxDays: number | null;
  current: number | null;
} {
  if (bars.length < 2) return { max: null, maxDays: null, current: null };
  let peak = bars[0].c;
  let peakIdx = 0;
  let maxDd = 0;
  let maxDays: number | null = null;
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].c;
    if (c > peak) {
      peak = c;
      peakIdx = i;
    } else if (peak > 0) {
      const dd = c / peak - 1;
      if (dd < maxDd) {
        maxDd = dd;
        maxDays = i - peakIdx;
      }
    }
  }
  const runMax = Math.max(...bars.map((b) => b.c));
  const current = runMax > 0 ? bars[bars.length - 1].c / runMax - 1 : null;
  return { max: maxDd, maxDays, current };
}

/** 歴史的 VaR (正の値で「この割合を失いうる」)。分位点は単純リターンで取る */
export function historicalVar(returns: number[], level: number): number | null {
  if (returns.length < 30) return null;
  const q = quantile(returns, 1 - level);
  return q === null ? null : Math.max(0, -q);
}

/** 条件付き VaR (テール平均損失) */
export function conditionalVar(returns: number[], level: number): number | null {
  if (returns.length < 30) return null;
  const q = quantile(returns, 1 - level);
  if (q === null) return null;
  const tail = returns.filter((r) => r <= q);
  const m = mean(tail);
  return m === null ? null : Math.max(0, -m);
}

/** 上昇/下落キャプチャ: ベンチマークが上げた日/下げた日だけの平均リターン比 */
export function captureRatios(
  asset: number[],
  bench: number[]
): { up: number | null; down: number | null } {
  const upA: number[] = [];
  const upB: number[] = [];
  const dnA: number[] = [];
  const dnB: number[] = [];
  const n = Math.min(asset.length, bench.length);
  for (let i = 0; i < n; i++) {
    if (bench[i] > 0) {
      upA.push(asset[i]);
      upB.push(bench[i]);
    } else if (bench[i] < 0) {
      dnA.push(asset[i]);
      dnB.push(bench[i]);
    }
  }
  const ratio = (a: number[], b: number[]) => {
    if (a.length < 10) return null;
    const ma = mean(a);
    const mb = mean(b);
    return ma === null || mb === null || Math.abs(mb) < 1e-12 ? null : ma / mb;
  };
  return { up: ratio(upA, upB), down: ratio(dnA, dnB) };
}

/**
 * リスク指標一式。
 *
 * 無リスク金利は 0 と置いている。地域ごとに通貨も金利水準も違う中で
 * 1 本の rf を全銘柄に当てると、比較が金利差の写像になってしまう。
 * 「rf=0 の超過リターン比」であることを riskFreeAssumption に明記して、
 * 絶対水準ではなく銘柄間の相対比較に使う前提を崩さない。
 */
export function computeRisk(
  bars: Bar[],
  benchmarkBars: Bar[] | null,
  benchmarkSymbol: string | null
): RiskMetrics {
  const lr = logReturns(bars);
  const sr = simpleReturns(bars);
  const lr252 = lr.slice(-TRADING_DAYS);
  const sr252 = sr.slice(-TRADING_DAYS);

  const vol20 = annualizedVol(lr, 20);
  const vol60 = annualizedVol(lr, 60);
  const vol252 = annualizedVol(lr, TRADING_DAYS);

  const dd = drawdown(bars.slice(-TRADING_DAYS * 2));
  const annReturn =
    lr252.length >= 60 ? (mean(lr252) ?? 0) * TRADING_DAYS : null;
  const dsd = downsideDeviation(lr252);

  let beta: number | null = null;
  let alphaAnnual: number | null = null;
  let rSquared: number | null = null;
  let corrBench: number | null = null;
  let trackingError: number | null = null;
  let informationRatio: number | null = null;
  let upCapture: number | null = null;
  let downCapture: number | null = null;

  if (benchmarkBars && benchmarkBars.length > 30) {
    const aligned = alignByDate(bars, benchmarkBars);
    if (aligned.days >= 60) {
      const a = aligned.a.slice(-TRADING_DAYS);
      const b = aligned.b.slice(-TRADING_DAYS);
      const reg = linreg(b, a);
      if (reg) {
        beta = reg.beta;
        alphaAnnual = reg.alpha * TRADING_DAYS;
        rSquared = reg.r2;
      }
      corrBench = correlation(a, b);
      const active = a.map((x, i) => x - b[i]);
      const te = stdev(active);
      trackingError = te === null ? null : te * Math.sqrt(TRADING_DAYS);
      const ma = mean(active);
      informationRatio =
        ma !== null && trackingError !== null && trackingError > 1e-9
          ? (ma * TRADING_DAYS) / trackingError
          : null;
      const cap = captureRatios(a, b);
      upCapture = cap.up;
      downCapture = cap.down;
    }
  }

  const sharpe =
    annReturn !== null && vol252 !== null && vol252 > 1e-9 ? annReturn / vol252 : null;
  const sortino =
    annReturn !== null && dsd !== null && dsd > 1e-9 ? annReturn / dsd : null;
  const calmar =
    annReturn !== null && dd.max !== null && dd.max < -1e-9 ? annReturn / -dd.max : null;

  const sd252 = stdev(lr252);
  const m252 = mean(lr252);
  const tailDays =
    sd252 !== null && m252 !== null
      ? lr252.filter((r) => Math.abs(r - m252) > 2 * sd252).length
      : null;

  return {
    vol20: round(vol20),
    vol60: round(vol60),
    vol252: round(vol252),
    volRatio:
      vol20 !== null && vol252 !== null && vol252 > 1e-9 ? round(vol20 / vol252, 3) : null,
    downsideDeviation: round(dsd),
    beta: round(beta, 3),
    alphaAnnual: round(alphaAnnual),
    rSquared: round(rSquared, 3),
    correlationToBenchmark: round(corrBench, 3),
    trackingError: round(trackingError),
    informationRatio: round(informationRatio, 3),
    upCapture: round(upCapture, 3),
    downCapture: round(downCapture, 3),
    maxDrawdown: round(dd.max),
    maxDrawdownDays: dd.maxDays,
    currentDrawdown: round(dd.current),
    sharpe: round(sharpe, 3),
    sortino: round(sortino, 3),
    calmar: round(calmar, 3),
    var95: round(historicalVar(sr252, 0.95)),
    var99: round(historicalVar(sr252, 0.99)),
    cvar95: round(conditionalVar(sr252, 0.95)),
    cvar99: round(conditionalVar(sr252, 0.99)),
    skewness: round(skewness(clean(lr252)), 3),
    kurtosis: round(kurtosis(clean(lr252)), 3),
    tailDays,
    benchmark: benchmarkSymbol,
    riskFreeAssumption: "無リスク金利 0% (通貨横断での相対比較を優先)",
  };
}

export { isNum };
