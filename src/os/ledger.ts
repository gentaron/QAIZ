/**
 * 優位性台帳 (Quantum Advantage Ledger)。
 *
 * QAIZ が量子について主張してよいのは「測った分だけ」という原則を、
 * データ構造として強制するための層。
 *
 * 記録するのは 2 種類の量に限る:
 *
 *  1. **クエリ計算量** — オラクル呼び出し数 / サンプル数。
 *     ハードウェアに載せ替えてもそのまま引き継がれる、実装非依存の量。
 *  2. **解の品質** — 厳密解が出せる規模では近似比、出せない規模では相対比較。
 *
 * 逆に、絶対に優位性として記録しないもの:
 *  - シミュレータの壁時計時間 (状態ベクトルは 2ⁿ なので必ず古典に負ける)
 *  - 「量子的な」名前がついた古典統計量 (Fubini-Study 距離など)
 */

export type BackendKind = "classical" | "quantum-sim" | "quantum-hardware";

export interface SolverRun {
  backend: string;
  kind: BackendKind;
  wallMs: number;
  /**
   * 作業量。問題クラスごとに意味が決まっている:
   *  - basket-qubo   : 評価した候補解の個数
   *  - tail-amplitude: オラクル (A) の呼び出し回数 / MC サンプル数
   */
  queries: number;
  /** 到達した目的関数値 (小さいほど良い。振幅推定では未使用) */
  value?: number;
  ok: boolean;
  error?: string;
  detail?: Record<string, number | string | boolean>;
}

export type AdvantageVerdict =
  | { kind: "none"; reason: string }
  | { kind: "query-model"; factor: number; note: string }
  | { kind: "unverified"; reason: string };

export interface LedgerEntry {
  ts: string;
  problem: "basket-qubo" | "tail-amplitude";
  /** 問題サイズ (量子ビット数) */
  size: number;
  runs: SolverRun[];
  quality?: {
    exactOptimum: number;
    achieved: number;
    /** 近似比 (1.0 が厳密解一致)。最小化問題なので exact/achieved で正規化 */
    approximationRatio: number;
  };
  verdict: AdvantageVerdict;
  /** 人間向けの一文サマリ */
  summary: string;
}

export interface Ledger {
  version: 1;
  entries: LedgerEntry[];
}

export const LEDGER_CAPACITY = 200;

export function emptyLedger(): Ledger {
  return { version: 1, entries: [] };
}

export function appendEntry(ledger: Ledger, entry: LedgerEntry): Ledger {
  const entries = [entry, ...ledger.entries].slice(0, LEDGER_CAPACITY);
  return { version: 1, entries };
}

/**
 * 厳密解が存在する規模での判定。
 * 「量子シミュレータの方が壁時計が速かった」は優位性ではないので、
 * ここでは必ず none を返し、理由を明示する。
 */
export function verdictWithExact(
  exactRun: SolverRun,
  quantumRun: SolverRun | undefined,
  size: number
): AdvantageVerdict {
  if (!quantumRun || !quantumRun.ok) {
    return { kind: "none", reason: "量子バックエンドが実行されなかった" };
  }
  return {
    kind: "none",
    reason:
      `n=${size} は厳密列挙が ${exactRun.queries.toLocaleString()} 候補 / ` +
      `${exactRun.wallMs.toFixed(1)}ms で終わる規模。` +
      `この領域に量子的優位は存在しない (QAOA は厳密解の再現に留まる)。`,
  };
}

/** 厳密解が現実的でない規模でのヒューリスティクス同士の比較 */
export function verdictHeuristicOnly(
  classicalRun: SolverRun,
  quantumRun: SolverRun | undefined,
  size: number
): AdvantageVerdict {
  if (!quantumRun || !quantumRun.ok) {
    return { kind: "none", reason: "量子バックエンドが実行されなかった" };
  }
  const c = classicalRun.value ?? Infinity;
  const q = quantumRun.value ?? Infinity;
  return {
    kind: "unverified",
    reason:
      `n=${size} では厳密解が取れないため近似比を確定できない。` +
      `古典SA=${fmt(c)} / QAOA=${fmt(q)}。` +
      `解の優劣は言えても、これは優位性の証明ではない ` +
      `(QAOA の性能保証は一般の QUBO では未確立)。`,
  };
}

/**
 * 振幅推定の判定。ここだけは胸を張って優位性を主張できる —
 * ただし主張してよいのは「クエリ計算量が二次で改善する」という一点のみ。
 */
export function verdictQueryModel(
  classicalSamples: number,
  quantumOracleCalls: number,
  epsilon: number
): AdvantageVerdict {
  if (quantumOracleCalls <= 0) {
    return { kind: "none", reason: "量子側の実行が無い" };
  }
  const factor = classicalSamples / quantumOracleCalls;
  if (factor <= 1) {
    return {
      kind: "none",
      reason:
        `ε=${epsilon} では定数倍が効いて古典 ${classicalSamples} 回 ≤ ` +
        `量子 ${quantumOracleCalls} 回。二次高速化は漸近的な話なので、` +
        `粗い精度では古典が勝つ。`,
    };
  }
  return {
    kind: "query-model",
    factor,
    note:
      `ε=${epsilon} で古典 ${classicalSamples.toLocaleString()} サンプル vs ` +
      `量子 ${quantumOracleCalls.toLocaleString()} オラクル呼び出し ` +
      `(×${factor.toFixed(2)})。ε を半分にすると比は約2倍になる — ` +
      `これが Θ(1/ε²) と O(1/ε) の差。壁時計時間の主張ではない。`,
  };
}

/**
 * 厳密列挙が破綻する問題サイズ。
 * 「今は優位が無い」で終わらせず、どこから話が変わるのかを数字で持つ。
 */
export function exactEnumerationWall(
  cardinality: number,
  budgetCandidates = 1e9
): number {
  for (let n = cardinality; n < 512; n++) {
    if (binomial(n, Math.min(cardinality, n)) > budgetCandidates) return n;
  }
  return 512;
}

export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= kk; i++) r = (r * (n - kk + i)) / i;
  return r;
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toPrecision(6) : "n/a";
}
