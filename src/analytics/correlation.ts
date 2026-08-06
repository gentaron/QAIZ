import type { Bar, CorrelationBlock } from "../types.ts";
import { alignByDate } from "./returns.ts";
import { correlation, isNum, mean, round } from "./stats.ts";

/**
 * 相関構造の分析。
 *
 * 分散投資が効いているかどうかは、銘柄数ではなく相関で決まる。
 * ここでは 3 つを出す:
 *   1. 相関行列 (ペア単位)
 *   2. 平均ペア相関 — 高いほど「全部が一緒に動く」相場
 *   3. 第1主成分の寄与率 — 市場全体が 1 本の因子で説明できる度合い
 * さらに相関距離で階層クラスタリングし、「実質いくつの塊に分かれているか」
 * を出す。10 銘柄持っていても塊が 2 つなら、分散は 2 本ぶんしかない。
 */

export interface CorrInput {
  symbol: string;
  label: string;
  bars: Bar[];
}

export function correlationMatrix(
  inputs: CorrInput[],
  window = 126
): CorrelationBlock | null {
  const n = inputs.length;
  if (n < 3) return null;

  const matrix = new Array(n * n).fill(0);
  const pairs: number[] = [];
  for (let i = 0; i < n; i++) {
    matrix[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const al = alignByDate(inputs[i].bars, inputs[j].bars);
      const c =
        al.days >= 40 ? correlation(al.a.slice(-window), al.b.slice(-window)) : null;
      const value = isNum(c) ? c : 0;
      matrix[i * n + j] = round(value, 4)!;
      matrix[j * n + i] = round(value, 4)!;
      if (isNum(c)) pairs.push(c);
    }
  }

  const meanPairwise = mean(pairs) ?? 0;
  const { share, loadings } = principalComponent(matrix, n);
  const clusters = clusterByCorrelation(matrix, n, inputs.map((i) => i.symbol));

  return {
    symbols: inputs.map((i) => i.symbol),
    labels: inputs.map((i) => i.label),
    matrix,
    window,
    meanPairwise: round(meanPairwise, 4)!,
    pc1Share: round(share, 4)!,
    pc1Loadings: loadings.map((x) => round(x, 4)!),
    clusters,
  };
}

/**
 * 冪乗法で相関行列の第1固有ベクトル/固有値を求める。
 * 相関行列はトレースが n なので、寄与率 = λ1 / n。
 */
export function principalComponent(
  matrix: number[],
  n: number,
  iterations = 200
): { share: number; loadings: number[]; eigenvalue: number } {
  let v = new Array(n).fill(1 / Math.sqrt(n));
  let lambda = 0;
  for (let it = 0; it < iterations; it++) {
    const w = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += matrix[i * n + j] * v[j];
      w[i] = acc;
    }
    const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
    if (norm < 1e-12) break;
    const next = w.map((x) => x / norm);
    const delta = next.reduce((a, x, i) => a + Math.abs(x - v[i]), 0);
    v = next;
    lambda = norm;
    if (delta < 1e-10) break;
  }
  // 符号は任意なので、多数派が正になるよう揃える (読みやすさのため)
  const positives = v.filter((x) => x > 0).length;
  if (positives < n / 2) v = v.map((x) => -x);
  return { share: n > 0 ? lambda / n : 0, loadings: v, eigenvalue: lambda };
}

/**
 * 相関距離 d = √(2(1−ρ)) による平均連結の階層クラスタリング。
 * しきい値で切って平坦なクラスタにする。
 */
export function clusterByCorrelation(
  matrix: number[],
  n: number,
  symbols: string[],
  threshold = 1.0
): { id: number; symbols: string[] }[] {
  const dist = (i: number, j: number) => Math.sqrt(Math.max(0, 2 * (1 - matrix[i * n + j])));

  let groups: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const groupDist = (a: number[], b: number[]) => {
    let acc = 0;
    for (const i of a) for (const j of b) acc += dist(i, j);
    return acc / (a.length * b.length);
  };

  while (groups.length > 1) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const d = groupDist(groups[i], groups[j]);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (best > threshold || bi < 0) break;
    const merged = [...groups[bi], ...groups[bj]];
    groups = groups.filter((_, k) => k !== bi && k !== bj);
    groups.push(merged);
  }

  return groups
    .sort((a, b) => b.length - a.length)
    .map((g, id) => ({ id, symbols: g.map((i) => symbols[i]).sort() }));
}
