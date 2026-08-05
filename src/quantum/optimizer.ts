/**
 * Nelder-Mead シンプレックス法 (微分不要)。
 *
 * QAOA のパラメータ最適化は「ノイズを含む期待値のブラックボックス最小化」なので、
 * 勾配法より導関数不要法が実務的。SPSA/COBYLA と並ぶ標準的な選択肢で、
 * 依存を増やさずに書き切れる。
 */

export interface NelderMeadOptions {
  maxEvals?: number;
  /** シンプレックスがこの大きさ以下に潰れたら収束とみなす */
  tolX?: number;
  /** 目的関数値の広がりがこれ以下なら収束 */
  tolF?: number;
  /** 初期シンプレックスの一辺 */
  step?: number;
  /** 経過時間の上限 (ms)。エッジの CPU 予算を守るために必須 */
  timeBudgetMs?: number;
  now?: () => number;
}

export interface NelderMeadResult {
  x: number[];
  fx: number;
  evals: number;
  converged: boolean;
}

export function nelderMead(
  f: (x: number[]) => number,
  x0: number[],
  opts: NelderMeadOptions = {}
): NelderMeadResult {
  const maxEvals = opts.maxEvals ?? 400;
  const tolX = opts.tolX ?? 1e-6;
  const tolF = opts.tolF ?? 1e-9;
  const step = opts.step ?? 0.4;
  const now = opts.now ?? (() => Date.now());
  const deadline = opts.timeBudgetMs != null ? now() + opts.timeBudgetMs : Infinity;

  const n = x0.length;
  let evals = 0;
  const evalF = (x: number[]) => {
    evals++;
    return f(x);
  };

  // 初期シンプレックス: x0 と各軸方向に step ずらした点
  const simplex: { x: number[]; fx: number }[] = [];
  simplex.push({ x: [...x0], fx: evalF(x0) });
  for (let i = 0; i < n; i++) {
    const x = [...x0];
    x[i] += step;
    simplex.push({ x, fx: evalF(x) });
  }

  const alpha = 1, gamma = 2, rho = 0.5, sigma = 0.5;
  let converged = false;

  while (evals < maxEvals) {
    // 予算 0 を渡したら 1 反復も回さずに止まること (打ち切り挙動を決定論にする)
    if (now() >= deadline) break;
    simplex.sort((a, b) => a.fx - b.fx);

    const spreadF = Math.abs(simplex[n].fx - simplex[0].fx);
    let spreadX = 0;
    for (let i = 1; i <= n; i++) {
      for (let d = 0; d < n; d++) {
        spreadX = Math.max(spreadX, Math.abs(simplex[i].x[d] - simplex[0].x[d]));
      }
    }
    if (spreadF < tolF && spreadX < tolX) {
      converged = true;
      break;
    }

    // 重心 (最悪点を除く)
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < n; d++) centroid[d] += simplex[i].x[d] / n;
    }
    const worst = simplex[n];

    const project = (coef: number) =>
      centroid.map((cd, d) => cd + coef * (cd - worst.x[d]));

    const xr = project(alpha);
    const fr = evalF(xr);

    if (fr < simplex[0].fx) {
      const xe = project(gamma);
      const fe = evalF(xe);
      simplex[n] = fe < fr ? { x: xe, fx: fe } : { x: xr, fx: fr };
      continue;
    }
    if (fr < simplex[n - 1].fx) {
      simplex[n] = { x: xr, fx: fr };
      continue;
    }
    const xc = project(-rho);
    const fc = evalF(xc);
    if (fc < worst.fx) {
      simplex[n] = { x: xc, fx: fc };
      continue;
    }
    // 縮小
    for (let i = 1; i <= n; i++) {
      const x = simplex[0].x.map((x0d, d) => x0d + sigma * (simplex[i].x[d] - x0d));
      simplex[i] = { x, fx: evalF(x) };
    }
  }

  simplex.sort((a, b) => a.fx - b.fx);
  return { x: simplex[0].x, fx: simplex[0].fx, evals, converged };
}
