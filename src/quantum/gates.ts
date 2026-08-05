/**
 * 1量子ビットゲートのユニタリ行列。
 *
 * 表現は複素 2x2 を実数8要素にフラット化したもの:
 *   [re00, im00, re01, im01, re10, im10, re11, im11]
 *
 * Float64Array を避けて素の配列にしているのは、
 * ゲート行列は小さく生成頻度が高いため GC 圧の方が支配的だから。
 */
export type Mat2 = readonly [
  number, number, number, number, number, number, number, number
];

const S2 = Math.SQRT1_2;

export const I: Mat2 = [1, 0, 0, 0, 0, 0, 1, 0];
export const X: Mat2 = [0, 0, 1, 0, 1, 0, 0, 0];
export const Y: Mat2 = [0, 0, 0, -1, 0, 1, 0, 0];
export const Z: Mat2 = [1, 0, 0, 0, 0, 0, -1, 0];
export const H: Mat2 = [S2, 0, S2, 0, S2, 0, -S2, 0];
export const S: Mat2 = [1, 0, 0, 0, 0, 0, 0, 1];
export const T: Mat2 = [1, 0, 0, 0, 0, 0, S2, S2];

/** RX(θ) = exp(-i θ X / 2) */
export function rx(theta: number): Mat2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, 0, -s, 0, -s, c, 0];
}

/** RY(θ) = exp(-i θ Y / 2) — 実行列なので振幅ロードに使いやすい */
export function ry(theta: number): Mat2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, 0, -s, 0, s, 0, c, 0];
}

/** RZ(θ) = exp(-i θ Z / 2) = diag(e^{-iθ/2}, e^{iθ/2}) */
export function rz(theta: number): Mat2 {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [c, -s, 0, 0, 0, 0, c, s];
}

/** P(θ) = diag(1, e^{iθ}) */
export function phase(theta: number): Mat2 {
  return [1, 0, 0, 0, 0, 0, Math.cos(theta), Math.sin(theta)];
}

/** 既知のゲート名 (OpenQASM3 への書き出しで使う) */
export type GateName =
  | "id" | "x" | "y" | "z" | "h" | "s" | "t"
  | "rx" | "ry" | "rz" | "p";

export function matrixOf(name: GateName, params: number[]): Mat2 {
  switch (name) {
    case "id": return I;
    case "x": return X;
    case "y": return Y;
    case "z": return Z;
    case "h": return H;
    case "s": return S;
    case "t": return T;
    case "rx": return rx(params[0]);
    case "ry": return ry(params[0]);
    case "rz": return rz(params[0]);
    case "p": return phase(params[0]);
  }
}
