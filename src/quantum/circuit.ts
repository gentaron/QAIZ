import { matrixOf, type GateName } from "./gates.ts";
import { StateVector } from "./statevector.ts";

/**
 * 量子回路の中間表現 (IR) と資源見積り。
 *
 * QVM は速度のために融合演算 (対角位相の一括適用など) を使うが、
 * **実機に投げるときの本当のコストはゲート数と深さ**である。
 * そこで回路 IR は「シミュレータ用の高速実装」と「分解後のゲート列」を
 * 同じ命令が両方持つ構造にした。優位性台帳が参照するのは後者。
 */

export interface ResourceEstimate {
  qubits: number;
  /** 1量子ビットゲート数 */
  gates1q: number;
  /** 2量子ビットゲート数 (CX 換算) */
  gates2q: number;
  /** 回路深さ (量子ビットごとの最長経路) */
  depth: number;
}

export const ZERO_ESTIMATE: Omit<ResourceEstimate, "qubits"> = {
  gates1q: 0,
  gates2q: 0,
  depth: 0,
};

/** 標準ゲート (制御なし/あり) */
export interface GateInstr {
  kind: "gate";
  name: GateName;
  controls: number[];
  target: number;
  params: number[];
}

/**
 * 融合命令。シミュレータでは `apply` が O(2^n) で走るが、
 * 実機では `expand()` が返すゲート列に分解される。
 */
export interface FusedInstr {
  kind: "fused";
  name: string;
  qubits: number[];
  apply: (sv: StateVector) => void;
  /** 実機向けの等価ゲート列 (資源見積り・QASM 出力に使う) */
  expand: () => GateInstr[];
}

/**
 * 不透明命令。等価回路を明示的に書き下していないもの
 * (整数コンパレータなど、標準的な構成が知られているブロック)。
 * 資源見積りは文献ベースの上限を手で与え、その旨を `note` に残す。
 */
export interface OpaqueInstr {
  kind: "opaque";
  name: string;
  qubits: number[];
  apply: (sv: StateVector) => void;
  estimate: Omit<ResourceEstimate, "qubits">;
  note: string;
  /** 自己逆 (U² = I) なら逆回路構成で使い回せる。オラクルは通常これ */
  selfInverse?: boolean;
}

export type Instr = GateInstr | FusedInstr | OpaqueInstr;

export class Circuit {
  readonly n: number;
  readonly instrs: Instr[] = [];

  constructor(n: number) {
    this.n = n;
  }

  gate(name: GateName, target: number, params: number[] = []): this {
    this.instrs.push({ kind: "gate", name, controls: [], target, params });
    return this;
  }

  cgate(
    name: GateName,
    controls: number[],
    target: number,
    params: number[] = []
  ): this {
    this.instrs.push({ kind: "gate", name, controls: [...controls], target, params });
    return this;
  }

  fused(instr: Omit<FusedInstr, "kind">): this {
    this.instrs.push({ kind: "fused", ...instr });
    return this;
  }

  opaque(instr: Omit<OpaqueInstr, "kind">): this {
    this.instrs.push({ kind: "opaque", ...instr });
    return this;
  }

  /** 別の回路を丸ごと連結する */
  append(other: Circuit): this {
    if (other.n !== this.n) throw new Error("qubit count mismatch");
    this.instrs.push(...other.instrs);
    return this;
  }

  /** シミュレータで実行 */
  run(sv: StateVector): void {
    if (sv.n !== this.n) throw new Error("qubit count mismatch");
    for (const ins of this.instrs) {
      switch (ins.kind) {
        case "gate": {
          const m = matrixOf(ins.name, ins.params);
          if (ins.controls.length === 0) sv.applyGate(ins.target, m);
          else sv.applyControlledGate(ins.controls, ins.target, m);
          break;
        }
        case "fused":
        case "opaque":
          ins.apply(sv);
          break;
      }
    }
  }

  /**
   * 逆回路 U†。振幅推定の Grover 演算子 Q = A S₀ A† S_χ に必要。
   * 逆を定義できない命令があれば、黙って間違った回路を返すより例外で落とす。
   */
  inverse(): Circuit {
    const inv = new Circuit(this.n);
    for (let i = this.instrs.length - 1; i >= 0; i--) {
      const ins = this.instrs[i];
      if (ins.kind === "gate") {
        inv.instrs.push(invertGate(ins));
      } else if (ins.kind === "opaque" && ins.selfInverse) {
        inv.instrs.push(ins);
      } else {
        throw new Error(`instruction "${ins.name}" has no defined inverse`);
      }
    }
    return inv;
  }

  /**
   * 実機に投げた場合の資源見積り。
   *
   * 多重制御ゲートは Nielsen-Chuang 4.10 の標準構成
   * (制御 k 個 → 補助なしで O(k²) の CX、k≤2 は既知の定数) で換算する。
   * 概算であることを隠さないため、注記を `notes` に集める。
   */
  estimate(): ResourceEstimate & { notes: string[] } {
    const notes: string[] = [];
    let g1 = 0;
    let g2 = 0;
    const layer = new Int32Array(this.n); // 量子ビットごとの現在深さ

    const account = (instrs: GateInstr[]) => {
      for (const g of instrs) {
        const k = g.controls.length;
        const touched = [g.target, ...g.controls];
        const at = Math.max(...touched.map((q) => layer[q]));
        if (k === 0) {
          g1 += 1;
          for (const q of touched) layer[q] = at + 1;
        } else if (k === 1) {
          // 制御付き 1量子ビット回転 = CX 2個 + 1量子ビット 3個
          g1 += 3;
          g2 += 2;
          for (const q of touched) layer[q] = at + 5;
        } else {
          // 多重制御: 補助ビットなしの標準分解 (Barenco et al. 1995)
          const cx = 16 * (k - 1);
          g1 += 8 * (k - 1);
          g2 += cx;
          for (const q of touched) layer[q] = at + cx;
        }
      }
    };

    for (const ins of this.instrs) {
      if (ins.kind === "gate") {
        account([ins]);
      } else if (ins.kind === "fused") {
        account(ins.expand());
      } else {
        g1 += ins.estimate.gates1q;
        g2 += ins.estimate.gates2q;
        const at = Math.max(...ins.qubits.map((q) => layer[q]));
        for (const q of ins.qubits) layer[q] = at + ins.estimate.depth;
        notes.push(`${ins.name}: ${ins.note}`);
      }
    }

    return {
      qubits: this.n,
      gates1q: g1,
      gates2q: g2,
      depth: Math.max(0, ...layer),
      notes,
    };
  }

  /**
   * OpenQASM 3 へ書き出す。実機バックエンド (IBM / IonQ 等) への投入用。
   * 不透明命令は等価回路を持たないので、コメントとして残し実行不能にする —
   * 「投げられるふり」をして黙って壊れるより、明示的に落ちる方がよい。
   */
  toQasm3(): { source: string; complete: boolean } {
    const lines = [
      "OPENQASM 3.0;",
      'include "stdgates.inc";',
      `qubit[${this.n}] q;`,
      `bit[${this.n}] c;`,
    ];
    let complete = true;

    const emit = (g: GateInstr) => {
      const p = g.params.length ? `(${g.params.map(fmt).join(", ")})` : "";
      const args = [...g.controls, g.target].map((i) => `q[${i}]`).join(", ");
      const ctrl = g.controls.length ? `ctrl(${g.controls.length}) @ ` : "";
      lines.push(`${ctrl}${g.name}${p} ${args};`);
    };

    for (const ins of this.instrs) {
      if (ins.kind === "gate") emit(ins);
      else if (ins.kind === "fused") {
        lines.push(`// fused: ${ins.name}`);
        for (const g of ins.expand()) emit(g);
      } else {
        complete = false;
        lines.push(`// OPAQUE ${ins.name} on q[${ins.qubits.join("], q[")}]`);
        lines.push(`//   ${ins.note}`);
        lines.push(`//   (要デコンパイル: 実機投入前に等価回路への展開が必要)`);
      }
    }

    lines.push("c = measure q;");
    return { source: lines.join("\n") + "\n", complete };
  }
}

function fmt(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : x.toPrecision(12);
}

function invertGate(g: GateInstr): GateInstr {
  switch (g.name) {
    case "id": case "x": case "y": case "z": case "h":
      return g;
    case "s":
      return { ...g, name: "p", params: [-Math.PI / 2] };
    case "t":
      return { ...g, name: "p", params: [-Math.PI / 4] };
    case "rx": case "ry": case "rz": case "p":
      return { ...g, params: g.params.map((p) => -p) };
  }
}
