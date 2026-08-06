import type { FactorScores, PriceSummary, RiskMetrics, Scorecard } from "../types.ts";
import { isNum, round, weightedMean, zscores, zToScore } from "./stats.ts";

/**
 * クロスセクショナル・ファクターモデル。
 *
 * バリュー / クオリティ / モメンタム / グロース / 低ボラの 5 本を
 * それぞれピア群内の Z スコアに落としてから加重合成する。
 *
 * 加重合成を Z の段階でやるのが要点。0-100 のスコアに直してから
 * 平均すると、分布の端が潰れているぶん「全部そこそこ」の銘柄が
 * 上位に来る。Z のまま足せば、1 本でも突出したファクターがある
 * 銘柄がちゃんと上に出る。
 */

export interface FactorWeights {
  value: number;
  quality: number;
  momentum: number;
  growth: number;
  lowVol: number;
}

export const DEFAULT_FACTOR_WEIGHTS: FactorWeights = {
  value: 0.25,
  quality: 0.25,
  momentum: 0.25,
  growth: 0.15,
  lowVol: 0.1,
};

export function parseWeights(json: string | undefined): FactorWeights {
  if (!json) return DEFAULT_FACTOR_WEIGHTS;
  try {
    const raw = JSON.parse(json) as Partial<FactorWeights>;
    const w: FactorWeights = { ...DEFAULT_FACTOR_WEIGHTS };
    for (const k of Object.keys(w) as (keyof FactorWeights)[]) {
      if (isNum(raw[k]) && raw[k]! >= 0) w[k] = raw[k]!;
    }
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    if (total <= 0) return DEFAULT_FACTOR_WEIGHTS;
    for (const k of Object.keys(w) as (keyof FactorWeights)[]) w[k] /= total;
    return w;
  } catch {
    return DEFAULT_FACTOR_WEIGHTS;
  }
}

export interface FactorInput {
  symbol: string;
  price: PriceSummary;
  risk: RiskMetrics;
  valuation: Scorecard | null;
  quality: Scorecard | null;
  growth: Scorecard | null;
  /** テクニカル合議スコア [0,100]。モメンタムの確認材料として使う */
  technicalScore: number | null;
  above200dma: boolean | null;
}

/** スコアカードの 0-100 を Z 相当に戻す (zToScore の逆写像) */
function scoreToZ(score: number | null): number | null {
  return isNum(score) ? ((score - 50) / 50) * 2.5 : null;
}

/**
 * モメンタム・ファクター。
 *
 * 主軸は 12-1 モメンタム。そこに 3 ヶ月リターンと 52 週レンジ内位置、
 * テクニカル合議を薄く混ぜる。直近 1 ヶ月リターンは *負* に効かせている
 * — 短期リバーサルは実証的に頑健なので、先月の急騰は加点ではなく減点。
 */
function momentumComponents(inputs: FactorInput[]): (number | null)[] {
  const z12 = zscores(inputs.map((i) => i.price.r12m1m), { winsorizeAt: 0.05, robust: true });
  const z3 = zscores(inputs.map((i) => i.price.r3m), { winsorizeAt: 0.05, robust: true });
  const z1 = zscores(inputs.map((i) => i.price.r1m), { winsorizeAt: 0.05, robust: true });
  const zRange = zscores(inputs.map((i) => i.price.rangePosition52w), { winsorizeAt: 0.05 });
  const zTech = zscores(inputs.map((i) => i.technicalScore), { winsorizeAt: 0.05 });

  return inputs.map((inp, i) => {
    const parts = [
      { value: z12[i], weight: 1.4 },
      { value: z3[i], weight: 0.8 },
      { value: z1[i] === null ? null : -z1[i]!, weight: 0.3 },
      { value: zRange[i], weight: 0.6 },
      { value: zTech[i], weight: 0.5 },
    ];
    const wm = weightedMean(parts);
    if (wm.value === null) return null;
    // 200日線割れは順張りの前提が壊れている状態。ペナルティを明示的に入れる。
    const penalty = inp.above200dma === false ? -0.35 : 0;
    return wm.value + penalty;
  });
}

/** 低ボラ・ファクター: ボラティリティと下方リスクが小さいほど高い */
function lowVolComponents(inputs: FactorInput[]): (number | null)[] {
  const zVol = zscores(
    inputs.map((i) => (isNum(i.risk.vol252) ? -i.risk.vol252 : null)),
    { winsorizeAt: 0.05, robust: true }
  );
  const zDd = zscores(
    inputs.map((i) => (isNum(i.risk.maxDrawdown) ? i.risk.maxDrawdown : null)),
    { winsorizeAt: 0.05, robust: true }
  );
  const zDown = zscores(
    inputs.map((i) => (isNum(i.risk.downCapture) ? -i.risk.downCapture : null)),
    { winsorizeAt: 0.05, robust: true }
  );
  return inputs.map((_, i) => {
    const wm = weightedMean([
      { value: zVol[i], weight: 1.2 },
      { value: zDd[i], weight: 0.8 },
      { value: zDown[i], weight: 0.6 },
    ]);
    return wm.value;
  });
}

export function computeFactors(
  inputs: FactorInput[],
  weights: FactorWeights = DEFAULT_FACTOR_WEIGHTS
): Map<string, FactorScores> {
  const out = new Map<string, FactorScores>();
  if (inputs.length === 0) return out;

  const zValue = inputs.map((i) => scoreToZ(i.valuation?.score ?? null));
  const zQuality = inputs.map((i) => scoreToZ(i.quality?.score ?? null));
  const zGrowth = inputs.map((i) => scoreToZ(i.growth?.score ?? null));
  const zMom = momentumComponents(inputs);
  const zLowVol = lowVolComponents(inputs);

  const coverages: number[] = [];
  const composites: (number | null)[] = inputs.map((_, i) => {
    const parts = [
      { value: zValue[i], weight: weights.value },
      { value: zQuality[i], weight: weights.quality },
      { value: zMom[i], weight: weights.momentum },
      { value: zGrowth[i], weight: weights.growth },
      { value: zLowVol[i], weight: weights.lowVol },
    ];
    const wm = weightedMean(parts);
    coverages.push(round(wm.usedWeight, 3)!);
    // 使えたウェイトが 3 割に満たない銘柄には総合を付けない。
    // ETF や指数はファンダが原理的に存在せず勢い+低ボラ (既定 0.35) しか
    // 埋まらないので、閾値をこれ以上上げると全ETFが圏外になる。
    // 代わりに coverage を返し、どの土俵で付けたスコアかを開示する。
    return wm.usedWeight >= 0.3 ? wm.value : null;
  });

  // 順位付け (合成が取れた銘柄のみ)
  const ranked = composites
    .map((c, i) => ({ i, c }))
    .filter((x): x is { i: number; c: number } => isNum(x.c))
    .sort((a, b) => b.c - a.c);
  const rankOf = new Map<number, number>();
  ranked.forEach((r, k) => rankOf.set(r.i, k + 1));

  inputs.forEach((inp, i) => {
    const contributions = [
      { factor: "value", weight: weights.value, z: zValue[i] },
      { factor: "quality", weight: weights.quality, z: zQuality[i] },
      { factor: "momentum", weight: weights.momentum, z: zMom[i] },
      { factor: "growth", weight: weights.growth, z: zGrowth[i] },
      { factor: "lowVol", weight: weights.lowVol, z: zLowVol[i] },
    ].map((c) => ({
      factor: c.factor,
      weight: c.weight,
      z: round(c.z, 3),
      contribution: round(isNum(c.z) ? c.z * c.weight : 0, 4)!,
    }));

    out.set(inp.symbol, {
      value: zToScore(zValue[i]),
      quality: zToScore(zQuality[i]),
      momentum: zToScore(zMom[i]),
      growth: zToScore(zGrowth[i]),
      lowVol: zToScore(zLowVol[i]),
      composite: zToScore(composites[i]),
      coverage: coverages[i],
      rank: rankOf.get(i) ?? null,
      peerCount: ranked.length,
      contributions,
    });
  });
  return out;
}
