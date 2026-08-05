import test from "node:test";
import assert from "node:assert/strict";

import {
  solveExact,
  solveQaoa,
  solveSimulatedAnnealing,
} from "../src/os/backends.ts";
import {
  approximationRatio,
  recordEntries,
  runBasketJob,
  runTailRiskJob,
} from "../src/os/kernel.ts";
import {
  appendEntry,
  binomial,
  emptyLedger,
  exactEnumerationWall,
  LEDGER_CAPACITY,
  verdictQueryModel,
  type LedgerEntry,
  type SolverRun,
} from "../src/os/ledger.ts";
import { qpuConfigured, submitToQpu } from "../src/os/qpu.ts";
import { Circuit } from "../src/quantum/circuit.ts";
import {
  addLinear,
  addQuadratic,
  energyOfMask,
  makeQubo,
  popcount,
  type Qubo,
} from "../src/quantum/qubo.ts";
import { mulberry32 } from "../src/quantum/rng.ts";
import { covarianceMatrix, type BasketInput } from "../src/problems/basket.ts";

function randomQubo(n: number, seed: number): Qubo {
  const rng = mulberry32(seed);
  const q = makeQubo(n);
  for (let i = 0; i < n; i++) {
    addLinear(q, i, (rng() - 0.5) * 2);
    for (let j = i + 1; j < n; j++) addQuadratic(q, i, j, (rng() - 0.5) * 1.5);
  }
  return q;
}

function bruteForce(q: Qubo, k: number | null): { best: number; worst: number } {
  let best = Infinity;
  let worst = -Infinity;
  for (let b = 0; b < 1 << q.n; b++) {
    if (k != null && popcount(b) !== k) continue;
    const e = energyOfMask(q, b);
    best = Math.min(best, e);
    worst = Math.max(worst, e);
  }
  return { best, worst };
}

function marketInput(n: number, seed: number, K: number): { input: BasketInput; returns: number[][] } {
  const rng = mulberry32(seed);
  const T = 150;
  const common = Array.from({ length: T }, () => (rng() - 0.5) * 0.02);
  const returns = Array.from({ length: n }, () => {
    const beta = 0.3 + rng();
    return Array.from({ length: T }, (_, t) => beta * common[t] + (rng() - 0.5) * 0.02);
  });
  const mu = Float64Array.from({ length: n }, () => rng());
  return {
    input: {
      ids: Array.from({ length: n }, (_, i) => `A${i}`),
      mu,
      sigma: covarianceMatrix(returns),
      cardinality: K,
      riskAversion: 50,
    },
    returns,
  };
}

// ------------------------------------------------------------- バックエンド

test("厳密列挙は真の最適解を返す (基数制約あり)", () => {
  for (const seed of [1, 2, 3]) {
    const q = randomQubo(10, seed);
    const K = 4;
    const { best, worst } = bruteForce(q, K);
    const sol = solveExact(q, K, { budgetMs: 1000 });
    assert.ok(Math.abs(sol.energy - best) < 1e-9, `seed=${seed}`);
    assert.ok(Math.abs(sol.worstEnergy! - worst) < 1e-9);
    assert.equal(popcount(sol.mask), K);
    assert.equal(sol.run.queries, binomial(10, K));
  }
});

test("厳密列挙は制約なしなら 2ⁿ 全部を見る", () => {
  const q = randomQubo(8, 4);
  const { best } = bruteForce(q, null);
  const sol = solveExact(q, null, { budgetMs: 1000 });
  assert.ok(Math.abs(sol.energy - best) < 1e-9);
  assert.equal(sol.run.queries, 256);
});

test("焼きなましは基数制約を保つ", () => {
  const q = randomQubo(12, 7);
  const sol = solveSimulatedAnnealing(q, 5, { budgetMs: 200, seed: 3 });
  assert.equal(popcount(sol.mask), 5);
  assert.ok(sol.run.ok);
});

test("焼きなましは厳密解に十分近い (小規模なら一致する)", () => {
  const q = randomQubo(10, 9);
  const { best } = bruteForce(q, 4);
  const sol = solveSimulatedAnnealing(q, 4, { budgetMs: 500, seed: 1 });
  assert.ok(sol.energy <= best + 1e-6, `SA=${sol.energy} 最適=${best}`);
});

test("QAOA バックエンドは量子ビット上限を超えたら実行せず理由を返す", () => {
  const q = randomQubo(10, 2);
  const sol = solveQaoa(q, 4, { budgetMs: 100, maxQubits: 8 });
  assert.equal(sol.run.ok, false);
  assert.match(sol.run.error!, /上限/);
  assert.equal(sol.run.queries, 0, "実行していないのに作業量を計上しないこと");
});

test("QAOA バックエンドの run には回路資源が記録される", () => {
  const q = randomQubo(8, 3);
  const sol = solveQaoa(q, 3, { budgetMs: 800, seed: 1, layers: 2 });
  assert.equal(sol.run.kind, "quantum-sim");
  assert.equal(sol.run.detail?.mixer, "xy");
  assert.ok((sol.run.detail?.gates2q as number) > 0);
  assert.equal(sol.run.detail?.leakage, 0);
});

// ------------------------------------------------------------- 近似比

test("approximationRatio: 最適解に一致すれば 1", () => {
  assert.equal(approximationRatio(-5, -5, 0), 1);
});

test("approximationRatio: 最悪解なら 0", () => {
  assert.equal(approximationRatio(-5, 3, 3), 0);
});

test("approximationRatio: 負のエネルギーでも [0,1] に収まる", () => {
  const r = approximationRatio(-10, -6, -2);
  assert.ok(r > 0 && r < 1, `r=${r}`);
  assert.ok(Math.abs(r - 0.5) < 1e-12);
});

test("approximationRatio: 最悪解が不明なら NaN (捏造しない)", () => {
  assert.ok(Number.isNaN(approximationRatio(-5, -4)));
});

// ------------------------------------------------------------- 台帳

test("台帳は容量を超えたら古いものから捨てる", () => {
  let ledger = emptyLedger();
  const entry = (i: number): LedgerEntry => ({
    ts: new Date(i * 1000).toISOString(),
    problem: "basket-qubo",
    size: i,
    runs: [],
    verdict: { kind: "none", reason: "test" },
    summary: `#${i}`,
  });
  for (let i = 0; i < LEDGER_CAPACITY + 20; i++) ledger = appendEntry(ledger, entry(i));
  assert.equal(ledger.entries.length, LEDGER_CAPACITY);
  assert.equal(ledger.entries[0].size, LEDGER_CAPACITY + 19, "最新が先頭");
});

test("recordEntries は null の台帳から始められる", () => {
  const l = recordEntries(null, [
    {
      ts: "t",
      problem: "tail-amplitude",
      size: 6,
      runs: [],
      verdict: { kind: "none", reason: "x" },
      summary: "s",
    },
  ]);
  assert.equal(l.entries.length, 1);
});

test("verdictQueryModel: 古典の方が少ないサンプルで済むなら優位なしと言う", () => {
  const v = verdictQueryModel(100, 500, 0.1);
  assert.equal(v.kind, "none");
});

test("verdictQueryModel: 量子が少ないクエリで済むときだけ優位を主張する", () => {
  const v = verdictQueryModel(18445, 2000, 0.01);
  assert.equal(v.kind, "query-model");
  if (v.kind === "query-model") assert.ok(Math.abs(v.factor - 9.2225) < 1e-6);
});

test("exactEnumerationWall: K を増やすと壁が手前に来る", () => {
  const w5 = exactEnumerationWall(5);
  const w10 = exactEnumerationWall(10);
  assert.ok(w10 < w5, `K=10 の壁 ${w10} が K=5 の壁 ${w5} より遠い`);
  assert.ok(binomial(w5, 5) > 1e9);
});

test("binomial は既知の値と一致する", () => {
  assert.equal(Math.round(binomial(16, 6)), 8008);
  assert.equal(Math.round(binomial(10, 0)), 1);
  assert.equal(binomial(5, 6), 0);
});

// ------------------------------------------------------------- カーネル

test("runBasketJob: 全バックエンドが横並びで記録される", () => {
  const { input } = marketInput(12, 5, 4);
  const job = runBasketJob(input, { budgetMs: 800, seed: 1 });

  const backends = job.runs.map((r) => r.backend);
  assert.ok(backends.some((b) => b === "exact-enumeration"));
  assert.ok(backends.some((b) => b === "simulated-annealing"));
  assert.ok(backends.some((b) => b.startsWith("qaoa")));
  assert.equal(job.solution.feasible, true);
  assert.equal(job.solution.selected.length, 4);
});

test("runBasketJob: 厳密解が取れる規模では優位性を主張しない", () => {
  const { input } = marketInput(12, 6, 4);
  const job = runBasketJob(input, { budgetMs: 800, seed: 1 });
  assert.equal(job.entry.verdict.kind, "none");
  assert.match(job.entry.verdict.reason!, /厳密列挙/);
});

test("runBasketJob: 厳密解が取れないときは unverified で正直に止まる", () => {
  const { input } = marketInput(14, 7, 7);
  const job = runBasketJob(input, {
    budgetMs: 600,
    seed: 1,
    maxExactCandidates: 10, // 厳密列挙を意図的に禁止する
  });
  assert.equal(job.exact, null);
  assert.equal(job.entry.verdict.kind, "unverified");
  assert.equal(job.entry.quality, undefined, "分母が無いなら近似比を出さないこと");
});

test("runBasketJob: 採用解は厳密解と一致する (小規模)", () => {
  const { input } = marketInput(12, 8, 4);
  const job = runBasketJob(input, { budgetMs: 1500, seed: 1 });
  assert.ok(job.exact);
  assert.deepEqual(job.solution.selected, job.exact!.selected);
});

test("runBasketJob: CPU 予算が極小でも解を返す (縮退しない)", () => {
  const { input } = marketInput(12, 9, 4);
  const job = runBasketJob(input, { budgetMs: 1, seed: 1 });
  assert.equal(job.solution.selected.length, 4);
  assert.ok(job.runs.length >= 3, "実行しなかったバックエンドも理由付きで残ること");
});

test("runTailRiskJob: 古典と量子の両方が必ず記録される", () => {
  const { returns } = marketInput(6, 10, 3);
  const basket = returns[0].map((_, t) => (returns[0][t] + returns[1][t]) / 2);
  const job = runTailRiskJob({ returns: basket, epsilon: 0.01, bins: 32 }, { budgetMs: 300, seed: 2 });

  assert.equal(job.runs.length, 2);
  assert.ok(job.runs.some((r) => r.kind === "classical"));
  assert.ok(job.runs.some((r) => r.kind === "quantum-sim"));
  assert.equal(job.entry.problem, "tail-amplitude");
  assert.ok(job.risk.queryAdvantage > 0);
});

test("runTailRiskJob: 判定は台帳のクエリ数と整合する", () => {
  const { returns } = marketInput(6, 11, 3);
  const basket = returns[0];
  const job = runTailRiskJob({ returns: basket, epsilon: 0.01, bins: 32 }, { budgetMs: 300, seed: 2 });
  const classical = job.runs.find((r) => r.backend === "monte-carlo")!;
  const quantum = job.runs.find((r) => r.backend === "iqae-statevector")!;
  if (job.entry.verdict.kind === "query-model") {
    assert.ok(
      Math.abs(job.entry.verdict.factor - classical.queries / quantum.queries) < 1e-9
    );
  }
});

// ------------------------------------------------------------- QPU アダプタ

test("QPU 未設定なら明示的に unavailable (ダミー結果を返さない)", async () => {
  const c = new Circuit(1);
  c.gate("h", 0);
  const out = await submitToQpu({}, { circuit: c, shots: 100, label: "t" });
  assert.equal(out.available, false);
  assert.equal(out.counts, undefined);
  assert.match(out.run.error!, /QPU 未設定/);
});

test("qpuConfigured は endpoint と token の両方を要求する", () => {
  assert.equal(qpuConfigured({}), false);
  assert.equal(qpuConfigured({ endpoint: "https://x" }), false);
  assert.equal(qpuConfigured({ endpoint: "https://x", token: "t" }), true);
});

test("不透明命令を含む回路は実機に投げない", async () => {
  const c = new Circuit(1);
  c.opaque({
    name: "oracle",
    qubits: [0],
    apply: () => {},
    estimate: { gates1q: 0, gates2q: 3, depth: 2 },
    note: "未分解",
  });
  const out = await submitToQpu(
    { endpoint: "https://example.invalid", token: "t", backend: "sim" },
    { circuit: c, shots: 10, label: "t" }
  );
  assert.equal(out.available, false);
  assert.match(out.run.error!, /不透明命令/);
});

test("QPU に投げるのは OpenQASM3 の本文", async () => {
  const c = new Circuit(2);
  c.gate("h", 0).cgate("x", [0], 1);
  const captured: { body: string; auth: string }[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      body: String(init?.body),
      auth: String((init?.headers as Record<string, string>).Authorization),
    });
    return new Response(JSON.stringify({ counts: { "00": 60, "11": 40 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const out = await submitToQpu(
    { endpoint: "https://example.invalid/jobs", token: "secret", backend: "ibm_x" },
    { circuit: c, shots: 100, label: "unit" },
    fakeFetch
  );

  assert.equal(out.available, true);
  assert.equal(out.run.ok, true);
  assert.deepEqual(out.counts, { "00": 60, "11": 40 });
  assert.equal(captured.length, 1);
  assert.match(captured[0].auth, /Bearer secret/);
  assert.match(JSON.parse(captured[0].body).program, /OPENQASM 3\.0;/);
});

test("QPU がエラーを返したら ok=false で記録される", async () => {
  const c = new Circuit(1);
  c.gate("h", 0);
  const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const out = await submitToQpu(
    { endpoint: "https://example.invalid", token: "t" },
    { circuit: c, shots: 1, label: "t" },
    fakeFetch
  );
  assert.equal(out.run.ok, false);
  assert.match(out.run.error!, /HTTP 503/);
});
