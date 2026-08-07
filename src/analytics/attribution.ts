import type { Bar, FactorAttribution, FactorTilt, InstrumentRecord } from "../types.ts";
import type { FactorDay } from "../datasources/kenfrench.ts";
import { frenchDateToDayKey } from "../datasources/kenfrench.ts";
import { ols, approxPValue, isSignificant } from "./regression.ts";
import { isNum, mean, round } from "./stats.ts";

/**
 * Fama-French ファクター帰属。
 *
 * この層の存在意義は「QAIZ が何か新しいことを言えているか」を、
 * QAIZ 自身の指標ではなく **外部の確立した基準** で測ることにある。
 *
 *   r_i − rf = α + β₁·Mkt + β₂·SMB + β₃·HML + β₄·RMW + β₅·CMA + β₆·Mom + ε
 *
 * α が有意に正なら、既知のファクターでは説明できない超過リターンがある。
 * 有意でなければ、その銘柄の値動きは既知の要因の組み合わせで説明が付く。
 *
 * 重要な限界を先に書いておく:
 *
 *   これは **過去のリターンの分解** であって、QAIZ のスコアが将来の
 *   リターンを予測できるかの検証ではない。後者には point-in-time の
 *   スコア履歴が要る (storage の scoreHistory で積み始めている)。
 *   現時点のスコアで銘柄を選んで過去リターンを測れば、選択自体が
 *   未来を見ているので必ず良い数字が出る。それは検証ではない。
 *
 * したがってここで出すのは「今の上位群がどのファクターに傾いているか」
 * という **記述** であって、成績ではない。
 */

const FACTOR_LABELS = [
  { key: "mktRf", nameJa: "市場 (Mkt-RF)", plain: "市場全体との連動。1 に近いほど指数と一緒に動く" },
  { key: "smb", nameJa: "規模 (SMB)", plain: "プラスなら小型株寄り、マイナスなら大型株寄り" },
  { key: "hml", nameJa: "バリュー (HML)", plain: "プラスなら割安株寄り、マイナスならグロース株寄り" },
  { key: "rmw", nameJa: "収益性 (RMW)", plain: "プラスなら高収益企業寄り" },
  { key: "cma", nameJa: "投資 (CMA)", plain: "プラスなら投資に保守的な企業寄り" },
  { key: "mom", nameJa: "モメンタム (Mom)", plain: "プラスなら勢いのある銘柄寄り" },
] as const;

/** 価格系列を「日 → 単純リターン」に変換する */
function dailyReturnsByDay(bars: Bar[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c;
    const b = bars[i].c;
    if (a > 0 && b > 0) out.set(Math.floor(bars[i].t / 86400), b / a - 1);
  }
  return out;
}

interface Aligned {
  y: number[];
  X: number[][];
  useMom: boolean;
}

/**
 * 銘柄リターンとファクター系列を日付で突き合わせる。
 *
 * モメンタムは別ファイル由来で更新が遅れることがあるため、
 * 欠損が多い場合は 5 ファクターに落とす。欠損日を 0 で埋めると
 * モメンタム係数が構造的にゼロ方向に歪む。
 */
function align(returns: Map<number, number>, factors: FactorDay[], window: number): Aligned | null {
  const recent = factors.slice(-window);
  const withMom = recent.filter((f) => isNum(f.mom)).length;
  const useMom = withMom >= recent.length * 0.9;

  const y: number[] = [];
  const X: number[][] = [];
  for (const f of recent) {
    const key = frenchDateToDayKey(f.d);
    const r = returns.get(key);
    if (r === undefined) continue;
    if (useMom && !isNum(f.mom)) continue;
    y.push(r - f.rf); // 超過リターン
    const row = [f.mktRf, f.smb, f.hml, f.rmw, f.cma];
    if (useMom) row.push(f.mom!);
    X.push(row);
  }
  if (y.length < 80) return null;
  return { y, X, useMom };
}

const TRADING_DAYS = 252;

/** 1 銘柄のファクター帰属 */
export function attributeInstrument(
  bars: Bar[],
  factors: FactorDay[],
  window = TRADING_DAYS
): FactorAttribution | null {
  const returns = dailyReturnsByDay(bars);
  const a = align(returns, factors, window);
  if (!a) return null;

  const r = ols(a.X, a.y);
  if (!r) return null;

  const labels = a.useMom ? FACTOR_LABELS : FACTOR_LABELS.slice(0, 5);
  const loadings = labels.map((l, i) => ({
    factor: l.key,
    nameJa: l.nameJa,
    plain: l.plain,
    beta: round(r.coefficients[i], 3)!,
    t: round(r.tStats[i], 2)!,
    significant: isSignificant(r.tStats[i]),
  }));

  const alphaAnnual = r.intercept * TRADING_DAYS;
  return {
    alphaDaily: round(r.intercept, 6)!,
    alphaAnnual: round(alphaAnnual, 4)!,
    alphaT: round(r.interceptT, 2)!,
    alphaP: approxPValue(r.interceptT),
    alphaSignificant: isSignificant(r.interceptT),
    rSquared: round(r.rSquared, 3)!,
    adjustedRSquared: round(r.adjustedRSquared, 3)!,
    observations: r.observations,
    window,
    factorsUsed: labels.map((l) => l.key),
    loadings,
    verdict: verdictFor(r.interceptT, alphaAnnual, r.rSquared),
  };
}

function verdictFor(t: number, alphaAnnual: number, r2: number): string {
  if (!isSignificant(t)) {
    return `既知のファクターで説明が付く範囲 (α の t 値 ${t.toFixed(2)} は有意水準に届かない)。R² ${(r2 * 100).toFixed(0)}%`;
  }
  return alphaAnnual > 0
    ? `既知のファクターでは説明できない超過リターン 年率 ${(alphaAnnual * 100).toFixed(1)}% (t = ${t.toFixed(2)})。ただし過去の実績であり、将来の再現は別問題`
    : `既知のファクターに対して劣後 年率 ${(alphaAnnual * 100).toFixed(1)}% (t = ${t.toFixed(2)})`;
}

/**
 * 銘柄群 (例: QAIZ 総合スコア上位) の等ウェイト・ポートフォリオを作り、
 * そのファクター傾斜を測る。
 *
 * 繰り返しになるが **これは成績ではない**。今のスコアで選んだ銘柄の
 * 過去リターンなので、選択に未来の情報が入っている。読めるのは
 * 「QAIZ の上位群がどのファクターに傾いているか」という性質だけ。
 */
export function attributeGroup(
  members: { symbol: string; bars: Bar[] }[],
  factors: FactorDay[],
  label: string,
  window = TRADING_DAYS
): FactorTilt | null {
  if (members.length < 3) return null;

  // 等ウェイトの日次リターンを合成する
  const perDay = new Map<number, number[]>();
  for (const m of members) {
    for (const [day, r] of dailyReturnsByDay(m.bars)) {
      const list = perDay.get(day) ?? [];
      list.push(r);
      perDay.set(day, list);
    }
  }
  const portfolio = new Map<number, number>();
  for (const [day, rs] of perDay) {
    // 構成銘柄の半分以上が値を持つ日だけ採用する。
    // 一部の銘柄しかない日を混ぜると、その日だけ別のポートフォリオになる
    if (rs.length >= members.length * 0.5) {
      const m = mean(rs);
      if (m !== null) portfolio.set(day, m);
    }
  }

  const a = align(portfolio, factors, window);
  if (!a) return null;
  const r = ols(a.X, a.y);
  if (!r) return null;

  const labels = a.useMom ? FACTOR_LABELS : FACTOR_LABELS.slice(0, 5);
  const alphaAnnual = r.intercept * TRADING_DAYS;

  // 最も傾斜の強いファクター (市場は除く。ほぼ必ず 1 付近になるため)
  const tilts = labels
    .map((l, i) => ({ key: l.key, nameJa: l.nameJa, beta: r.coefficients[i], t: r.tStats[i] }))
    .filter((x) => x.key !== "mktRf");
  const dominant = tilts
    .filter((x) => isSignificant(x.t))
    .sort((a2, b2) => Math.abs(b2.beta) - Math.abs(a2.beta))[0];

  return {
    label,
    members: members.map((m) => m.symbol),
    memberCount: members.length,
    alphaAnnual: round(alphaAnnual, 4)!,
    alphaT: round(r.interceptT, 2)!,
    alphaSignificant: isSignificant(r.interceptT),
    rSquared: round(r.rSquared, 3)!,
    observations: r.observations,
    window,
    loadings: labels.map((l, i) => ({
      factor: l.key,
      nameJa: l.nameJa,
      plain: l.plain,
      beta: round(r.coefficients[i], 3)!,
      t: round(r.tStats[i], 2)!,
      significant: isSignificant(r.tStats[i]),
    })),
    dominantTilt: dominant
      ? `${dominant.nameJa} に ${dominant.beta > 0 ? "順" : "逆"}方向へ傾斜 (β ${dominant.beta.toFixed(2)}, t ${dominant.t.toFixed(2)})`
      : "市場以外に有意な傾斜は検出されていない",
    caveat:
      "現時点のスコアで選んだ銘柄の過去リターンを見ているため、選択に未来の情報が入っている。" +
      "これは『どのファクターに傾いているか』という性質の記述であって、成績ではない。" +
      "予測力の検証には point-in-time のスコア履歴が必要で、そちらは蓄積を開始した段階。",
  };
}

export { FACTOR_LABELS };

/** レコードから帰属可能な銘柄を選ぶ (十分な履歴がある個別株 / ETF) */
export function attributable(rec: InstrumentRecord): boolean {
  return (
    (rec.instrument.role === "constituent" || rec.instrument.role === "sector-proxy") &&
    rec.dataQuality.bars >= 200
  );
}
