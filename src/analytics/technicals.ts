import type {
  Adx,
  Bar,
  Bollinger,
  Macd,
  MovingAverages,
  PivotLevels,
  Stochastic,
  SupportResistance,
  Technicals,
} from "../types.ts";
import { clamp, isNum, mean, quantile, round, smaSeries, stdev } from "./stats.ts";

/**
 * テクニカル指標ライブラリ。
 *
 * 平滑化は指標ごとに流儀が違う。RSI / ATR / ADX は Wilder の平滑
 * (α = 1/n)、MACD は通常の EMA (α = 2/(n+1))。ここを混ぜると
 * チャートツールと数字が合わなくなるので、意図的に分けて実装している。
 */

/* ------------------------------------------------------------------ */
/* 基本系列                                                            */
/* ------------------------------------------------------------------ */

export function closes(bars: Bar[]): number[] {
  return bars.map((b) => b.c);
}

export function emaSeries(xs: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (xs.length < period || period < 1) return out;
  const k = 2 / (period + 1);
  // 初期値は最初の period 本の単純平均 (一般的なチャートツールと同じ)
  let prev = xs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < xs.length; i++) {
    prev = xs[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder 平滑 (α = 1/period)。初期値は最初の period 本の単純平均 */
export function wilderSeries(xs: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (xs.length < period || period < 1) return out;
  let prev = xs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < xs.length; i++) {
    prev = (prev * (period - 1) + xs[i]) / period;
    out[i] = prev;
  }
  return out;
}

function lastOf(xs: (number | null)[]): number | null {
  for (let i = xs.length - 1; i >= 0; i--) if (isNum(xs[i])) return xs[i];
  return null;
}

/* ------------------------------------------------------------------ */
/* RSI                                                                 */
/* ------------------------------------------------------------------ */

/** Wilder RSI の系列。先頭 period 本は null */
export function rsiSeries(cs: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(cs.length).fill(null);
  if (cs.length <= period) return out;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i] - cs[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rsiAt = (g: number, l: number) =>
    l < 1e-12 ? (g < 1e-12 ? 50 : 100) : 100 - 100 / (1 + g / l);
  out[period] = rsiAt(avgGain, avgLoss);

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    out[i + 1] = rsiAt(avgGain, avgLoss);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* MACD                                                                */
/* ------------------------------------------------------------------ */

export function macdSeries(
  cs: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] } {
  const ef = emaSeries(cs, fast);
  const es = emaSeries(cs, slow);
  const macd: (number | null)[] = cs.map((_, i) =>
    isNum(ef[i]) && isNum(es[i]) ? ef[i]! - es[i]! : null
  );
  // シグナル線は MACD が確定した区間だけで EMA を取る
  const firstIdx = macd.findIndex(isNum);
  const sigOut: (number | null)[] = new Array(cs.length).fill(null);
  if (firstIdx >= 0) {
    const dense = macd.slice(firstIdx).map((x) => x as number);
    const sig = emaSeries(dense, signal);
    for (let i = 0; i < sig.length; i++) sigOut[firstIdx + i] = sig[i];
  }
  const hist = macd.map((m, i) => (isNum(m) && isNum(sigOut[i]) ? m - sigOut[i]! : null));
  return { macd, signal: sigOut, hist };
}

/* ------------------------------------------------------------------ */
/* ボリンジャーバンド                                                  */
/* ------------------------------------------------------------------ */

export function bollingerSeries(
  cs: number[],
  period = 20,
  mult = 2
): { middle: (number | null)[]; upper: (number | null)[]; lower: (number | null)[]; bandwidth: (number | null)[] } {
  const mid = smaSeries(cs, period);
  const upper: (number | null)[] = new Array(cs.length).fill(null);
  const lower: (number | null)[] = new Array(cs.length).fill(null);
  const bw: (number | null)[] = new Array(cs.length).fill(null);
  if (cs.length < period) return { middle: mid, upper, lower, bandwidth: bw };

  // 窓ごとに stdev を取り直すと O(n·period)。Workers の CPU 予算は
  // ミリ秒単位で効いてくるので、和と二乗和のローリングで O(n) にする。
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < cs.length; i++) {
    s += cs[i];
    s2 += cs[i] * cs[i];
    if (i >= period) {
      const drop = cs[i - period];
      s -= drop;
      s2 -= drop * drop;
    }
    if (i < period - 1) continue;
    const m = s / period;
    // 母集団分散 (チャートツールの慣行に合わせる。標本分散だと
    // 一般的なボリンジャーバンドより僅かに広くなる)
    const varr = Math.max(0, s2 / period - m * m);
    const sd = Math.sqrt(varr);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bw[i] = m !== 0 ? (2 * mult * sd) / m : null;
  }
  return { middle: mid, upper, lower, bandwidth: bw };
}

/* ------------------------------------------------------------------ */
/* ATR / ADX                                                           */
/* ------------------------------------------------------------------ */

export function trueRanges(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    out.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  return out;
}

export function atrSeries(bars: Bar[], period = 14): (number | null)[] {
  const tr = trueRanges(bars);
  const smoothed = wilderSeries(tr, period);
  // tr[i] は bars[i+1] に対応するので 1 本ずらす
  return [null, ...smoothed];
}

export function adxSeries(
  bars: Bar[],
  period = 14
): { adx: (number | null)[]; plusDi: (number | null)[]; minusDi: (number | null)[] } {
  const n = bars.length;
  const empty = new Array<number | null>(n).fill(null);
  if (n < period * 2 + 2) return { adx: empty, plusDi: [...empty], minusDi: [...empty] };

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr = trueRanges(bars);
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const sTr = wilderSeries(tr, period);
  const sPlus = wilderSeries(plusDm, period);
  const sMinus = wilderSeries(minusDm, period);

  const pdi: (number | null)[] = new Array(n).fill(null);
  const mdi: (number | null)[] = new Array(n).fill(null);
  const dx: number[] = [];
  let dxStart = -1;
  for (let i = 0; i < tr.length; i++) {
    const t = sTr[i];
    const p = sPlus[i];
    const m = sMinus[i];
    if (!isNum(t) || !isNum(p) || !isNum(m) || t < 1e-12) continue;
    const pv = (100 * p) / t;
    const mv = (100 * m) / t;
    pdi[i + 1] = pv;
    mdi[i + 1] = mv;
    const denom = pv + mv;
    if (denom > 1e-12) {
      if (dxStart < 0) dxStart = i + 1;
      dx.push((100 * Math.abs(pv - mv)) / denom);
    }
  }
  const adxDense = wilderSeries(dx, period);
  const adx: (number | null)[] = new Array(n).fill(null);
  if (dxStart >= 0) {
    for (let i = 0; i < adxDense.length; i++) {
      const at = dxStart + i;
      if (at < n) adx[at] = adxDense[i];
    }
  }
  return { adx, plusDi: pdi, minusDi: mdi };
}

/* ------------------------------------------------------------------ */
/* ストキャスティクス / MFI / CCI / Williams %R                        */
/* ------------------------------------------------------------------ */

export function stochasticSeries(
  bars: Bar[],
  period = 14,
  smoothK = 3,
  smoothD = 3
): { k: (number | null)[]; d: (number | null)[] } {
  const n = bars.length;
  const rawK: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    rawK[i] = hh - ll < 1e-12 ? 50 : ((bars[i].c - ll) / (hh - ll)) * 100;
  }
  const k = smoothNullable(rawK, smoothK);
  const d = smoothNullable(k, smoothD);
  return { k, d };
}

/** null 混じり系列の単純移動平均 (null 区間はまたがない) */
function smoothNullable(xs: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (window <= 1) return [...xs];
  for (let i = window - 1; i < xs.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = i - window + 1; j <= i; j++) {
      const v = xs[j];
      if (!isNum(v)) {
        ok = false;
        break;
      }
      acc += v;
    }
    if (ok) out[i] = acc / window;
  }
  return out;
}

export function typicalPrices(bars: Bar[]): number[] {
  return bars.map((b) => (b.h + b.l + b.c) / 3);
}

export function mfiSeries(bars: Bar[], period = 14): (number | null)[] {
  const n = bars.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n <= period) return out;
  const tp = typicalPrices(bars);
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 1; i < n; i++) {
    const v = bars[i].v;
    const flow = isNum(v) ? tp[i] * v : 0;
    if (tp[i] > tp[i - 1]) {
      pos.push(flow);
      neg.push(0);
    } else if (tp[i] < tp[i - 1]) {
      pos.push(0);
      neg.push(flow);
    } else {
      pos.push(0);
      neg.push(0);
    }
  }
  for (let i = period - 1; i < pos.length; i++) {
    let p = 0;
    let ng = 0;
    for (let j = i - period + 1; j <= i; j++) {
      p += pos[j];
      ng += neg[j];
    }
    if (p + ng < 1e-12) continue;
    out[i + 1] = ng < 1e-12 ? 100 : 100 - 100 / (1 + p / ng);
  }
  return out;
}

export function cciSeries(bars: Bar[], period = 20): (number | null)[] {
  const tp = typicalPrices(bars);
  const sma = smaSeries(tp, period);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    const m = sma[i];
    if (!isNum(m)) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - m);
    dev /= period;
    if (dev < 1e-12) continue;
    out[i] = (tp[i] - m) / (0.015 * dev);
  }
  return out;
}

export function williamsRSeries(bars: Bar[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (bars[j].h > hh) hh = bars[j].h;
      if (bars[j].l < ll) ll = bars[j].l;
    }
    out[i] = hh - ll < 1e-12 ? -50 : ((hh - bars[i].c) / (hh - ll)) * -100;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 出来高系                                                            */
/* ------------------------------------------------------------------ */

export function obvSeries(bars: Bar[]): (number | null)[] {
  // 出来高が 1 本も無い銘柄 (指数など) では OBV は定義できない
  if (!bars.some((b) => isNum(b.v))) return new Array(bars.length).fill(null);
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < bars.length; i++) {
    const v = bars[i].v ?? 0;
    if (bars[i].c > bars[i - 1].c) acc += v;
    else if (bars[i].c < bars[i - 1].c) acc -= v;
    out[i] = acc;
  }
  return out;
}

/** 出来高加重平均価格 (直近 window 本のローリング) */
export function vwap(bars: Bar[], window = 20): number | null {
  const slice = bars.slice(-window);
  const tp = typicalPrices(slice);
  let pv = 0;
  let vol = 0;
  slice.forEach((b, i) => {
    if (isNum(b.v) && b.v > 0) {
      pv += tp[i] * b.v;
      vol += b.v;
    }
  });
  return vol > 0 ? pv / vol : null;
}

/* ------------------------------------------------------------------ */
/* ピボット / 支持・抵抗                                               */
/* ------------------------------------------------------------------ */

export function classicPivots(bar: Bar): PivotLevels {
  const p = (bar.h + bar.l + bar.c) / 3;
  const range = bar.h - bar.l;
  return {
    pivot: p,
    r1: 2 * p - bar.l,
    r2: p + range,
    r3: bar.h + 2 * (p - bar.l),
    s1: 2 * p - bar.h,
    s2: p - range,
    s3: bar.l - 2 * (bar.h - p),
    method: "classic",
  };
}

export function fibonacciPivots(bar: Bar): PivotLevels {
  const p = (bar.h + bar.l + bar.c) / 3;
  const range = bar.h - bar.l;
  return {
    pivot: p,
    r1: p + 0.382 * range,
    r2: p + 0.618 * range,
    r3: p + 1.0 * range,
    s1: p - 0.382 * range,
    s2: p - 0.618 * range,
    s3: p - 1.0 * range,
    method: "fibonacci",
  };
}

/**
 * スイング高値/安値のクラスタリングによる支持・抵抗帯。
 *
 * 「直近高値」を 1 本だけ抵抗線にするのは弱い。同じ価格帯で
 * 何度も跳ね返されているほど強い帯なので、近い水準をまとめて
 * タッチ回数を数える。tolerance は価格に対する相対幅。
 */
export function supportResistance(
  bars: Bar[],
  opts: { lookback?: number; fractal?: number; tolerance?: number; maxLevels?: number } = {}
): SupportResistance {
  const lookback = opts.lookback ?? 180;
  const k = opts.fractal ?? 3;
  const tol = opts.tolerance ?? 0.015;
  const maxLevels = opts.maxLevels ?? 3;

  const win = bars.slice(-lookback);
  const last = win.length > 0 ? win[win.length - 1].c : null;
  if (last === null || win.length < k * 2 + 5) return { resistance: [], support: [] };

  const pivotsHigh: number[] = [];
  const pivotsLow: number[] = [];
  for (let i = k; i < win.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (win[j].h >= win[i].h) isHigh = false;
      if (win[j].l <= win[i].l) isLow = false;
    }
    if (isHigh) pivotsHigh.push(win[i].h);
    if (isLow) pivotsLow.push(win[i].l);
  }

  const cluster = (levels: number[]) => {
    const sorted = [...levels].sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const lv of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(lv - g[0]) / Math.max(1e-9, g[0]) <= tol) g.push(lv);
      else groups.push([lv]);
    }
    return groups.map((g) => ({
      level: g.reduce((a, b) => a + b, 0) / g.length,
      touches: g.length,
    }));
  };

  const withDistance = (
    items: { level: number; touches: number }[],
    above: boolean
  ) =>
    items
      .filter((x) => (above ? x.level > last * 1.001 : x.level < last * 0.999))
      .map((x) => ({ ...x, distancePct: (x.level - last) / last }))
      // 強さ (タッチ回数) を優先しつつ、遠すぎる帯は落とす
      .sort(
        (a, b) =>
          b.touches - a.touches || Math.abs(a.distancePct) - Math.abs(b.distancePct)
      )
      .slice(0, maxLevels)
      .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
      .map((x) => ({
        level: round(x.level, 4)!,
        touches: x.touches,
        distancePct: round(x.distancePct, 4)!,
      }));

  return {
    resistance: withDistance(cluster(pivotsHigh), true),
    support: withDistance(cluster(pivotsLow), false),
  };
}

/* ------------------------------------------------------------------ */
/* ダイバージェンス                                                    */
/* ------------------------------------------------------------------ */

/**
 * 価格とオシレーターのダイバージェンス。
 * 直近 lookback 本の中でスイング安値/高値を 2 点拾い、
 * 価格の方向とオシレーターの方向が食い違っていれば検出とする。
 */
export function detectDivergence(
  bars: Bar[],
  osc: (number | null)[],
  lookback = 70,
  fractal = 3
): "bullish" | "bearish" | "none" {
  const n = bars.length;
  const start = Math.max(fractal, n - lookback);
  const lows: { i: number; price: number; o: number }[] = [];
  const highs: { i: number; price: number; o: number }[] = [];
  for (let i = start; i < n - fractal; i++) {
    const o = osc[i];
    if (!isNum(o)) continue;
    let isLow = true;
    let isHigh = true;
    for (let j = i - fractal; j <= i + fractal; j++) {
      if (j === i || j < 0 || j >= n) continue;
      if (bars[j].l <= bars[i].l) isLow = false;
      if (bars[j].h >= bars[i].h) isHigh = false;
    }
    if (isLow) lows.push({ i, price: bars[i].l, o });
    if (isHigh) highs.push({ i, price: bars[i].h, o });
  }
  const lastTwo = <T>(xs: T[]) => (xs.length >= 2 ? [xs[xs.length - 2], xs[xs.length - 1]] : null);

  const lp = lastTwo(lows);
  if (lp && lp[1].price < lp[0].price * 0.995 && lp[1].o > lp[0].o + 1) return "bullish";
  const hp = lastTwo(highs);
  if (hp && hp[1].price > hp[0].price * 1.005 && hp[1].o < hp[0].o - 1) return "bearish";
  return "none";
}

/* ------------------------------------------------------------------ */
/* 組み立て                                                            */
/* ------------------------------------------------------------------ */

function crossAge(hist: (number | null)[]): number | null {
  const last = lastOf(hist);
  if (!isNum(last)) return null;
  const sign = Math.sign(last);
  let age = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const v = hist[i];
    if (!isNum(v)) break;
    if (Math.sign(v) !== sign) return age;
    age++;
    if (age > 250) return null;
  }
  return null;
}

function movingAverages(cs: number[]): MovingAverages {
  const s = (p: number) => lastOf(smaSeries(cs, p));
  const sma5 = s(5);
  const sma20 = s(20);
  const sma50 = s(50);
  const sma100 = s(100);
  const sma200 = s(200);
  const price = cs[cs.length - 1];

  const s50 = smaSeries(cs, 50);
  const s200 = smaSeries(cs, 200);
  let cross: MovingAverages["cross"] = "none";
  let crossAgeDays: number | null = null;
  if (isNum(sma50) && isNum(sma200)) {
    cross = sma50 > sma200 ? "golden" : "dead";
    const diff = cs.map((_, i) =>
      isNum(s50[i]) && isNum(s200[i]) ? s50[i]! - s200[i]! : null
    );
    crossAgeDays = crossAge(diff);
  }

  let perfectOrder: MovingAverages["perfectOrder"] = "none";
  if (isNum(sma5) && isNum(sma20) && isNum(sma50) && isNum(sma200)) {
    if (sma5 > sma20 && sma20 > sma50 && sma50 > sma200) perfectOrder = "bullish";
    else if (sma5 < sma20 && sma20 < sma50 && sma50 < sma200) perfectOrder = "bearish";
  }

  return {
    sma5: round(sma5),
    sma20: round(sma20),
    sma50: round(sma50),
    sma100: round(sma100),
    sma200: round(sma200),
    ema12: round(lastOf(emaSeries(cs, 12))),
    ema26: round(lastOf(emaSeries(cs, 26))),
    above: {
      sma20: isNum(sma20) ? price > sma20 : null,
      sma50: isNum(sma50) ? price > sma50 : null,
      sma200: isNum(sma200) ? price > sma200 : null,
    },
    deviation200: isNum(sma200) && sma200 !== 0 ? round(price / sma200 - 1) : null,
    cross,
    crossAgeDays,
    perfectOrder,
  };
}

/** 個別指標の判定を集めて 0-100 の合議スコアにする */
function composite(
  parts: { indicator: string; verdict: "bull" | "bear" | "flat"; weight: number; note: string }[]
): { score: number; label: Technicals["compositeLabel"]; breakdown: Technicals["breakdown"] } {
  let acc = 0;
  let w = 0;
  for (const p of parts) {
    const v = p.verdict === "bull" ? 1 : p.verdict === "bear" ? -1 : 0;
    acc += v * p.weight;
    w += p.weight;
  }
  // 全部 flat でも 50 になるよう、w が 0 のときは中立
  const norm = w > 0 ? acc / w : 0;
  const score = Math.round(clamp(50 + norm * 50, 0, 100) * 10) / 10;
  const label: Technicals["compositeLabel"] =
    score >= 75 ? "strong-buy" : score >= 60 ? "buy" : score <= 25 ? "strong-sell" : score <= 40 ? "sell" : "neutral";
  return {
    score,
    label,
    breakdown: parts.map((p) => ({ indicator: p.indicator, verdict: p.verdict, note: p.note })),
  };
}

export function computeTechnicals(bars: Bar[]): Technicals {
  const cs = closes(bars);
  const price = cs[cs.length - 1];
  const parts: { indicator: string; verdict: "bull" | "bear" | "flat"; weight: number; note: string }[] = [];

  /* RSI */
  const rsiS = rsiSeries(cs, 14);
  const rsi14 = lastOf(rsiS);
  const rsi14State = isNum(rsi14)
    ? rsi14 >= 70
      ? "overbought"
      : rsi14 <= 30
        ? "oversold"
        : "neutral"
    : null;
  if (isNum(rsi14)) {
    // RSI は「50 をどちら側で推移しているか」をトレンド判定に使う。
    // 70/30 は過熱の警告であって売買シグナルではないので、合議では
    // 中立側に寄せる (逆張りに引きずられて順張り局面を落とさないため)。
    parts.push({
      indicator: "RSI(14)",
      verdict: rsi14 >= 70 ? "flat" : rsi14 > 55 ? "bull" : rsi14 < 45 ? "bear" : "flat",
      weight: 1,
      note: `${rsi14.toFixed(1)} — ${rsi14 >= 70 ? "買われすぎ警戒" : rsi14 <= 30 ? "売られすぎ" : "中立圏"}`,
    });
  }
  const rsiDivergence = detectDivergence(bars, rsiS);

  /* 移動平均 */
  const ma = movingAverages(cs);
  if (ma.above.sma200 !== null) {
    parts.push({
      indicator: "200日線",
      verdict: ma.above.sma200 ? "bull" : "bear",
      weight: 1.5,
      note: `終値は200日線の${ma.above.sma200 ? "上" : "下"} (乖離 ${ma.deviation200 !== null ? (ma.deviation200 * 100).toFixed(1) : "?"}%)`,
    });
  }
  if (ma.above.sma50 !== null) {
    parts.push({
      indicator: "50日線",
      verdict: ma.above.sma50 ? "bull" : "bear",
      weight: 1,
      note: `終値は50日線の${ma.above.sma50 ? "上" : "下"}`,
    });
  }
  if (ma.cross !== "none") {
    parts.push({
      indicator: "50/200クロス",
      verdict: ma.cross === "golden" ? "bull" : "bear",
      weight: 1.2,
      note: `${ma.cross === "golden" ? "ゴールデンクロス" : "デッドクロス"}${ma.crossAgeDays !== null ? ` (${ma.crossAgeDays}営業日前)` : ""}`,
    });
  }

  /* MACD */
  const m = macdSeries(cs);
  const macdV = lastOf(m.macd);
  const sigV = lastOf(m.signal);
  const histV = lastOf(m.hist);
  let macd: Macd | null = null;
  if (isNum(macdV) && isNum(sigV) && isNum(histV)) {
    macd = {
      macd: round(macdV, 5)!,
      signal: round(sigV, 5)!,
      histogram: round(histV, 5)!,
      crossAgeDays: crossAge(m.hist),
      state: histV >= 0 ? "bullish" : "bearish",
    };
    parts.push({
      indicator: "MACD",
      verdict: histV > 0 ? "bull" : histV < 0 ? "bear" : "flat",
      weight: 1.2,
      note: `ヒストグラム ${histV >= 0 ? "+" : ""}${histV.toFixed(3)}${macd.crossAgeDays !== null ? ` / ${macd.crossAgeDays}営業日前に転換` : ""}`,
    });
  }

  /* ボリンジャー */
  const bb = bollingerSeries(cs, 20, 2);
  const bbMid = lastOf(bb.middle);
  const bbUp = lastOf(bb.upper);
  const bbLo = lastOf(bb.lower);
  const bbW = lastOf(bb.bandwidth);
  let bollinger: Bollinger | null = null;
  if (isNum(bbMid) && isNum(bbUp) && isNum(bbLo) && isNum(bbW)) {
    const percentB = bbUp - bbLo > 1e-12 ? (price - bbLo) / (bbUp - bbLo) : 0.5;
    const hist = bb.bandwidth.filter(isNum).slice(-120);
    const p20 = hist.length >= 30 ? quantile(hist, 0.2) : null;
    const bwPct =
      hist.length >= 30
        ? (hist.filter((x) => x <= bbW).length / hist.length) * 100
        : null;
    bollinger = {
      middle: round(bbMid)!,
      upper: round(bbUp)!,
      lower: round(bbLo)!,
      percentB: round(percentB, 3)!,
      bandwidth: round(bbW, 4)!,
      bandwidthPercentile: round(bwPct, 1),
      squeeze: p20 !== null && bbW <= p20,
    };
    parts.push({
      indicator: "ボリンジャー",
      verdict: percentB > 0.8 ? "bull" : percentB < 0.2 ? "bear" : "flat",
      weight: 0.8,
      note: `%B ${percentB.toFixed(2)}${bollinger.squeeze ? " / スクイーズ中 (放れ待ち)" : ""}`,
    });
  }

  /* ATR */
  const atr14 = lastOf(atrSeries(bars, 14));
  const atrPercent = isNum(atr14) && price > 0 ? atr14 / price : null;

  /* ストキャス */
  const st = stochasticSeries(bars, 14, 3, 3);
  const kV = lastOf(st.k);
  const dV = lastOf(st.d);
  let stochastic: Stochastic | null = null;
  if (isNum(kV) && isNum(dV)) {
    stochastic = {
      k: round(kV, 2)!,
      d: round(dV, 2)!,
      state: kV >= 80 ? "overbought" : kV <= 20 ? "oversold" : "neutral",
    };
    parts.push({
      indicator: "ストキャス",
      verdict: kV > dV && kV < 80 ? "bull" : kV < dV && kV > 20 ? "bear" : "flat",
      weight: 0.6,
      note: `%K ${kV.toFixed(1)} / %D ${dV.toFixed(1)} (${stochastic.state === "overbought" ? "買われすぎ" : stochastic.state === "oversold" ? "売られすぎ" : "中立"})`,
    });
  }

  /* ADX */
  const ax = adxSeries(bars, 14);
  const adxV = lastOf(ax.adx);
  const pdiV = lastOf(ax.plusDi);
  const mdiV = lastOf(ax.minusDi);
  let adx: Adx | null = null;
  if (isNum(adxV) && isNum(pdiV) && isNum(mdiV)) {
    adx = {
      adx: round(adxV, 2)!,
      plusDi: round(pdiV, 2)!,
      minusDi: round(mdiV, 2)!,
      regime: adxV >= 25 ? "trending" : adxV < 20 ? "ranging" : "transitional",
      direction: pdiV >= mdiV ? "up" : "down",
    };
    // ADX は強さだけを測る指標なので、方向は DI に持たせる。
    // レンジ相場 (ADX < 20) では方向の判定自体を出さない。
    parts.push({
      indicator: "ADX(14)",
      verdict: adxV < 20 ? "flat" : pdiV > mdiV ? "bull" : "bear",
      weight: 1,
      note: `ADX ${adxV.toFixed(1)} (${adx.regime === "trending" ? "トレンド" : adx.regime === "ranging" ? "レンジ" : "移行期"}) / +DI ${pdiV.toFixed(1)} vs -DI ${mdiV.toFixed(1)}`,
    });
  }

  /* OBV 勾配 */
  const obv = obvSeries(bars);
  let obvSlope20: number | null = null;
  const obvTail = obv.slice(-21).filter(isNum);
  if (obvTail.length >= 10) {
    const first = obvTail[0];
    const last = obvTail[obvTail.length - 1];
    const scale = Math.max(...obvTail.map(Math.abs), 1);
    obvSlope20 = round((last - first) / scale, 4);
    if (isNum(obvSlope20)) {
      parts.push({
        indicator: "OBV",
        verdict: obvSlope20 > 0.05 ? "bull" : obvSlope20 < -0.05 ? "bear" : "flat",
        weight: 0.7,
        note: `20日勾配 ${(obvSlope20 * 100).toFixed(1)}% — 出来高は${obvSlope20 > 0 ? "買い" : "売り"}方向に偏る`,
      });
    }
  }

  /* MFI / CCI / Williams %R / ROC */
  const mfi14 = lastOf(mfiSeries(bars, 14));
  if (isNum(mfi14)) {
    parts.push({
      indicator: "MFI(14)",
      verdict: mfi14 > 55 && mfi14 < 80 ? "bull" : mfi14 < 45 ? "bear" : "flat",
      weight: 0.6,
      note: `${mfi14.toFixed(1)} — 資金の流入${mfi14 >= 50 ? "超過" : "不足"}`,
    });
  }
  const cci20 = lastOf(cciSeries(bars, 20));
  const williamsR14 = lastOf(williamsRSeries(bars, 14));
  const roc20 =
    cs.length > 21 && cs[cs.length - 21] > 0 ? cs[cs.length - 1] / cs[cs.length - 21] - 1 : null;
  if (isNum(roc20)) {
    parts.push({
      indicator: "ROC(20)",
      verdict: roc20 > 0.02 ? "bull" : roc20 < -0.02 ? "bear" : "flat",
      weight: 0.8,
      note: `20日変化率 ${(roc20 * 100).toFixed(1)}%`,
    });
  }

  /* VWAP */
  const v20 = vwap(bars, 20);
  const vwapDeviation = isNum(v20) && v20 > 0 ? price / v20 - 1 : null;

  /* 上昇日比率 */
  let upDayRatio20: number | null = null;
  if (cs.length >= 21) {
    const w = cs.slice(-21);
    let up = 0;
    for (let i = 1; i < w.length; i++) if (w[i] > w[i - 1]) up++;
    upDayRatio20 = round(up / (w.length - 1), 3);
  }

  /* ダイバージェンス */
  if (rsiDivergence !== "none") {
    parts.push({
      indicator: "RSIダイバージェンス",
      verdict: rsiDivergence === "bullish" ? "bull" : "bear",
      weight: 0.9,
      note:
        rsiDivergence === "bullish"
          ? "価格は安値切り下げ / RSIは切り上げ (下げの勢い減衰)"
          : "価格は高値切り上げ / RSIは切り下げ (上げの勢い減衰)",
    });
  }

  const lastBar = bars[bars.length - 1];
  const c = composite(parts);

  return {
    rsi14: round(rsi14, 2),
    rsi14State,
    rsiDivergence,
    ma,
    macd,
    bollinger,
    atr14: round(atr14),
    atrPercent: round(atrPercent, 4),
    stochastic,
    adx,
    obvSlope20,
    mfi14: round(mfi14, 2),
    cci20: round(cci20, 2),
    williamsR14: round(williamsR14, 2),
    roc20: round(roc20, 4),
    vwap20: round(v20),
    vwapDeviation: round(vwapDeviation, 4),
    pivots: lastBar ? classicPivots(lastBar) : null,
    fibPivots: lastBar ? fibonacciPivots(lastBar) : null,
    levels: supportResistance(bars),
    upDayRatio20,
    compositeScore: c.score,
    compositeLabel: c.label,
    breakdown: c.breakdown,
  };
}

/** ダッシュボードのスパークライン用に終値を丸めて間引く */
export function sparkline(bars: Bar[], points = 120): number[] {
  const cs = closes(bars).slice(-points);
  return cs.map((c) => round(c, 4)!);
}

export { lastOf, mean as _mean };
