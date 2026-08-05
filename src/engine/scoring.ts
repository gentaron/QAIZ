import type {
  CosmoSpectral,
  Momentum,
  QuantumGeometry,
  SentimentResult,
} from "../types.ts";

/**
 * 総合ヒートスコア [0, 100]。
 * 「どのセクターがこれから熱くなりそうか」を1つの数字に集約する。
 *
 * 設計思想:
 *  - ベースはボラ調整済みマルチタイムフレーム・モメンタム (実証的に最も頑健)
 *  - Hurst > 0.5 (トレンド持続レジーム) のときモメンタムを増幅、
 *    Hurst < 0.5 (平均回帰レジーム) のとき減衰させる
 *  - Fubini-Study 距離が大きい (レジーム転換中) ときは、直近1週間の方向に
 *    「転換ブースト」を与える — 相転移の初動を捉えるため
 *  - ニュースセンチメントは ±10 点の範囲で加点/減点
 */

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** tanh でリターンを [0,1] に写像 (中心0.5) */
function squash(x: number, scale: number): number {
  return 0.5 * (1 + Math.tanh(x / scale));
}

export function computeHeatScore(
  momentum: Momentum,
  quantum: QuantumGeometry,
  cosmo: CosmoSpectral,
  sentiment: SentimentResult | null
): number {
  // --- 1. マルチタイムフレーム・モメンタム (0..1) ---
  const momScore =
    0.25 * squash(momentum.r1w, 0.04) +
    0.35 * squash(momentum.r1m, 0.08) +
    0.25 * squash(momentum.r3m, 0.15) +
    0.15 * clamp01(momentum.trendConsistency);

  // --- 2. レジーム係数: Hurst によるトレンド持続性の増幅/減衰 (0.8..1.2) ---
  const regimeGain = 0.8 + 0.4 * clamp01((cosmo.hurst - 0.3) / 0.4);

  // --- 3. 量子幾何の転換ブースト ---
  // d_FS ∈ [0, π/2]。0.9 rad 超は「状態空間で大きく動いた」= 転換発生中。
  // 転換中は直近1週間の方向へスコアを最大 ±8 点シフトする。
  const transitionIntensity = clamp01((quantum.fubiniStudy - 0.6) / 0.9);
  const transitionBoost =
    8 * transitionIntensity * Math.tanh(momentum.r1w / 0.03);

  // --- 4. QFI 感応度ペナルティ ---
  // 状態が過敏に揺れている (QFI大) ときは不確実性が高いので少し減点。
  const qfiPenalty = 4 * clamp01(quantum.qfiProxy / 2);

  // --- 5. センチメント (±10) ---
  const sentimentAdj = sentiment ? 10 * sentiment.score : 0;

  const base = 100 * clamp01(momScore * regimeGain);
  const heat = base + transitionBoost - qfiPenalty + sentimentAdj;
  return Math.round(Math.max(0, Math.min(100, heat)) * 10) / 10;
}
