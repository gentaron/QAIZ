import type { Circuit } from "../quantum/circuit.ts";
import type { SolverRun } from "./ledger.ts";

/**
 * 実機 QPU アダプタ。
 *
 * QAIZ は「量子OSを名乗るなら、シミュレータと実機の差し替え口が
 * 実際に存在しなければならない」という立場を取る。ここがその口。
 *
 * 環境変数 (wrangler secret) が揃っていなければ **明示的に unavailable を返す**。
 * ダミー結果を返して動いているふりをするのは、優位性台帳の意味を壊す。
 *
 *   QPU_ENDPOINT … OpenQASM 3 を受け付ける HTTP エンドポイント
 *   QPU_TOKEN    … Bearer トークン
 *   QPU_BACKEND  … バックエンド名 (例: ibm_brisbane, qpu.aria-1)
 */

export interface QpuConfig {
  endpoint?: string;
  token?: string;
  backend?: string;
}

export interface QpuSubmission {
  circuit: Circuit;
  shots: number;
  label: string;
}

export interface QpuOutcome {
  available: boolean;
  counts?: Record<string, number>;
  run: SolverRun;
}

export function qpuConfigured(cfg: QpuConfig): boolean {
  return Boolean(cfg.endpoint && cfg.token);
}

export async function submitToQpu(
  cfg: QpuConfig,
  sub: QpuSubmission,
  fetchImpl: typeof fetch = fetch
): Promise<QpuOutcome> {
  const t0 = Date.now();
  const base: SolverRun = {
    backend: `qpu:${cfg.backend ?? "unset"}`,
    kind: "quantum-hardware",
    wallMs: 0,
    queries: sub.shots,
    ok: false,
  };

  if (!qpuConfigured(cfg)) {
    return {
      available: false,
      run: {
        ...base,
        error:
          "QPU 未設定 (QPU_ENDPOINT / QPU_TOKEN)。実機バックエンドは無効。" +
          "設定すれば同じ回路がそのまま実機に飛ぶ。",
      },
    };
  }

  const qasm = sub.circuit.toQasm3();
  if (!qasm.complete) {
    return {
      available: false,
      run: {
        ...base,
        error:
          "回路に不透明命令 (未分解のオラクル) が含まれるため実機に投入できない。" +
          "等価回路への展開が必要。",
      },
    };
  }

  try {
    const res = await fetchImpl(cfg.endpoint!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        backend: cfg.backend,
        shots: sub.shots,
        label: sub.label,
        format: "openqasm3",
        program: qasm.source,
      }),
    });
    if (!res.ok) {
      return {
        available: true,
        run: { ...base, wallMs: Date.now() - t0, error: `HTTP ${res.status}` },
      };
    }
    const body = (await res.json()) as { counts?: Record<string, number> };
    return {
      available: true,
      counts: body.counts,
      run: {
        ...base,
        wallMs: Date.now() - t0,
        ok: Boolean(body.counts),
        detail: {
          gates2q: sub.circuit.estimate().gates2q,
          depth: sub.circuit.estimate().depth,
        },
      },
    };
  } catch (e) {
    return {
      available: true,
      run: { ...base, wallMs: Date.now() - t0, error: String(e) },
    };
  }
}
