import type { Bar, Instrument, RotationPoint } from "../types.ts";
import { alignByDate } from "./returns.ts";
import { isNum, mean, round, stdev } from "./stats.ts";

/**
 * 相対ローテーション (RRG 風) 座標。
 *
 * 元祖 JdK RS-Ratio / RS-Momentum は独自の平滑化を使う非公開仕様なので、
 * ここでは **Zスコア正規化版** を実装している。再現手順は以下の通り:
 *
 *   1. RS_t = 100 × (セクター価格_t / ベンチマーク価格_t)   … 相対力
 *   2. rsRatio_t = 100 + 10 × z_W(RS_t)                     … 自分の過去 W 日に対する位置
 *   3. rsMom_t   = 100 + 10 × z_W(rsRatio_t − rsRatio_{t−k}) … その変化の速さ
 *
 * 数字の絶対値は本家と一致しないが、四象限の意味 (先行/失速/劣後/改善) と
 * 軌跡の回転方向は同じになる。式を出しておくのは、見た目だけ似ている
 * チャートを「RRG です」と言って出すのが一番たちが悪いから。
 */

const WINDOW = 126;
const MOM_LAG = 10;

/** ローリング Z スコア。和と二乗和を持ち回して O(n) で回す */
function rollingZ(xs: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (xs.length < window) return out;
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    s2 += xs[i] * xs[i];
    if (i >= window) {
      const drop = xs[i - window];
      s -= drop;
      s2 -= drop * drop;
    }
    if (i < window - 1) continue;
    const m = s / window;
    const sd = Math.sqrt(Math.max(0, s2 / window - m * m));
    if (sd < 1e-12) continue;
    out[i] = (xs[i] - m) / sd;
  }
  return out;
}

export function rotationPoint(
  instrument: Instrument,
  bars: Bar[],
  benchmarkBars: Bar[]
): RotationPoint | null {
  // 日付を揃えてから比率を取る。営業日がずれた比率は
  // 相対力ではなく「休場のノイズ」を測ってしまう。
  const dayKey = (t: number) => Math.floor(t / 86400);
  const bench = new Map<number, number>();
  for (const b of benchmarkBars) bench.set(dayKey(b.t), b.c);

  const rs: number[] = [];
  for (const b of bars) {
    const bc = bench.get(dayKey(b.t));
    if (bc !== undefined && bc > 0 && b.c > 0) rs.push((100 * b.c) / bc);
  }
  if (rs.length < WINDOW + MOM_LAG + 5) return null;

  const z = rollingZ(rs, WINDOW);
  const ratioSeries = z.map((x) => (isNum(x) ? 100 + 10 * x : null));

  const momRaw: (number | null)[] = ratioSeries.map((r, i) =>
    i >= MOM_LAG && isNum(r) && isNum(ratioSeries[i - MOM_LAG])
      ? r - ratioSeries[i - MOM_LAG]!
      : null
  );
  const dense = momRaw.filter(isNum);
  const mm = mean(dense);
  const ms = stdev(dense);
  const momSeries = momRaw.map((x) =>
    isNum(x) && mm !== null && ms !== null && ms > 1e-12 ? 100 + 10 * ((x - mm) / ms) : null
  );

  const idxs: number[] = [];
  for (let i = ratioSeries.length - 1; i >= 0 && idxs.length < 6; i -= 5) {
    if (isNum(ratioSeries[i]) && isNum(momSeries[i])) idxs.push(i);
  }
  if (idxs.length === 0) return null;
  idxs.reverse();

  const lastI = idxs[idxs.length - 1];
  const rsRatio = ratioSeries[lastI]!;
  const rsMomentum = momSeries[lastI]!;

  const quadrant: RotationPoint["quadrant"] =
    rsRatio >= 100
      ? rsMomentum >= 100
        ? "leading"
        : "weakening"
      : rsMomentum >= 100
        ? "improving"
        : "lagging";

  return {
    symbol: instrument.symbol,
    name: instrument.nameJa,
    sector: instrument.sector,
    region: instrument.region,
    rsRatio: round(rsRatio, 2)!,
    rsMomentum: round(rsMomentum, 2)!,
    quadrant,
    trail: idxs.map((i) => ({
      rsRatio: round(ratioSeries[i], 2)!,
      rsMomentum: round(momSeries[i], 2)!,
    })),
  };
}

/**
 * 景気敏感 vs ディフェンシブのスプレッド。
 * ローテーションが「攻め」に向かっているのか「守り」なのかを 1 本の数字にする。
 */
export function cyclicalDefensiveSpread(
  points: { rsRatio: number; cyclicality: "cyclical" | "defensive" | "neutral" | undefined }[]
): number | null {
  const cyc = points.filter((p) => p.cyclicality === "cyclical").map((p) => p.rsRatio);
  const def = points.filter((p) => p.cyclicality === "defensive").map((p) => p.rsRatio);
  const mc = mean(cyc);
  const md = mean(def);
  return mc !== null && md !== null ? round(mc - md, 2) : null;
}

export { alignByDate };
