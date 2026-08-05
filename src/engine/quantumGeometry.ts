import type { QuantumGeometry } from "../types.ts";

/**
 * 量子情報幾何エンジン (エッジで動く古典シミュレーション)。
 *
 * リターン系列を確率振幅に写像して擬似的な量子状態 |ψ⟩ を構成し、
 * 状態空間 (射影ヒルベルト空間) 上の幾何量で市場レジームを測る:
 *
 *  - 忠実度        F(ψ1, ψ2) = |⟨ψ1|ψ2⟩|²
 *  - Fubini-Study 距離  d_FS = arccos(√F)   … 状態空間上の測地距離
 *  - 量子Fisher情報 (純粋状態) の古典近似 … パラメータ感応度=市場の敏感さ
 *  - シャノンエントロピー … 振幅分布の不確実性
 *
 * d_FS が大きい = 「直近の市場状態が過去の状態から測地的に遠い」
 * = レジーム転換 (相転移) の兆候、という解釈で運用する。
 */

/** リターン列 → 正規化された確率振幅ベクトル (符号を位相 ±1 として保持) */
export function amplitudeEncode(returns: number[]): number[] {
  const eps = 1e-12;
  const norm = Math.sqrt(
    returns.reduce((s, r) => s + r * r, 0) + eps
  );
  return returns.map((r) => r / norm);
}

/** ⟨ψ1|ψ2⟩ (実振幅なので内積) → 忠実度 F = |⟨ψ1|ψ2⟩|² */
export function fidelity(psi1: number[], psi2: number[]): number {
  const n = Math.min(psi1.length, psi2.length);
  let ip = 0;
  for (let i = 0; i < n; i++) ip += psi1[i] * psi2[i];
  return Math.min(1, ip * ip);
}

/** Fubini-Study 距離 d = arccos(√F) ∈ [0, π/2] */
export function fubiniStudyDistance(F: number): number {
  return Math.acos(Math.sqrt(Math.max(0, Math.min(1, F))));
}

/**
 * 量子Fisher情報の古典近似。
 * 純粋状態のQFIはパラメータ微分に対する状態変化率 4(⟨∂ψ|∂ψ⟩-|⟨ψ|∂ψ⟩|²)。
 * ここでは時間シフトをパラメータとみなし、隣接窓の状態差分で数値近似する。
 * 値が大きい = 状態が時間に対して鋭敏に動いている = 高感応レジーム。
 */
export function qfiProxy(returns: number[], window = 20): number {
  if (returns.length < window + 2) return 0;
  const psiT = amplitudeEncode(returns.slice(-window));
  const psiPrev = amplitudeEncode(returns.slice(-window - 1, -1));
  // |∂ψ⟩ ≈ |ψ(t)⟩ - |ψ(t-1)⟩
  const n = Math.min(psiT.length, psiPrev.length);
  let dd = 0; // ⟨∂ψ|∂ψ⟩
  let pd = 0; // ⟨ψ|∂ψ⟩
  for (let i = 0; i < n; i++) {
    const d = psiT[i] - psiPrev[i];
    dd += d * d;
    pd += psiT[i] * d;
  }
  return Math.max(0, 4 * (dd - pd * pd));
}

/** 振幅の二乗 (確率分布) のシャノンエントロピー、log2、最大値で正規化 [0,1] */
export function amplitudeEntropy(returns: number[]): number {
  const psi = amplitudeEncode(returns);
  const eps = 1e-12;
  let h = 0;
  for (const a of psi) {
    const p = a * a;
    if (p > eps) h -= p * Math.log2(p);
  }
  const hMax = Math.log2(psi.length || 1);
  return hMax > 0 ? h / hMax : 0;
}

/**
 * 主要指標をまとめて計算。
 * recent窓 (直近20営業日) と past窓 (その前の20営業日) の状態を比較する。
 */
export function computeQuantumGeometry(
  returns: number[],
  window = 20
): QuantumGeometry {
  if (returns.length < window * 2) {
    return { fidelity: 1, fubiniStudy: 0, qfiProxy: 0, entropy: 0 };
  }
  const recent = amplitudeEncode(returns.slice(-window));
  const past = amplitudeEncode(returns.slice(-window * 2, -window));
  const F = fidelity(recent, past);
  return {
    fidelity: F,
    fubiniStudy: fubiniStudyDistance(F),
    qfiProxy: qfiProxy(returns, window),
    entropy: amplitudeEntropy(returns.slice(-window)),
  };
}
