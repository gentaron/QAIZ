import test from "node:test";
import assert from "node:assert/strict";

import { runQuantumOs, type ScoredSector } from "../src/scheduled.ts";
import { mulberry32 } from "../src/quantum/rng.ts";
import type { SectorScore } from "../src/types.ts";

/**
 * パイプライン配線の統合テスト。
 *
 * 量子OSが実際に scheduled.ts から呼ばれる形 (ScoredSector[] と env 文字列変数) で
 * 動くこと、出力がそのまま Durable Object に入れられる JSON であることを固定する。
 * ネットワークにも Cloudflare にも触らないので CI で完走する。
 */

function scoredSector(id: string, heat: number, returns: number[]): ScoredSector {
  const score: SectorScore = {
    sector: { id, nameJa: id, nameEn: id, symbol: id.toUpperCase(), keywords: [] },
    momentum: { r1w: 0, r1m: 0, r3m: 0, volAdj: 0, trendConsistency: 0.5 },
    quantum: { fidelity: 1, fubiniStudy: 0, qfiProxy: 0, entropy: 0 },
    cosmo: { hurst: 0.5, spectralSlope: 0 },
    sentiment: null,
    heat,
    lastClose: 100,
    spark: [],
  };
  return { score, returns };
}

/** n セクター × T 日のリターンを合成する (共通ファクター + 個別ノイズ) */
function fakeUniverse(n: number, T: number, seed: number): ScoredSector[] {
  const rng = mulberry32(seed);
  const common = Array.from({ length: T }, () => (rng() - 0.5) * 0.022);
  return Array.from({ length: n }, (_, i) => {
    const beta = 0.3 + rng();
    const idio = 0.008 + rng() * 0.02;
    const returns = Array.from(
      { length: T },
      (_, t) => beta * common[t] + (rng() - 0.5) * idio
    );
    return scoredSector(`s${i}`, rng() * 100, returns);
  });
}

const ENV = {
  QUANTUM_BUDGET_MS: "400",
  BASKET_CARDINALITY: "5",
  TAIL_EPSILON: "0.01",
};

test("量子OSはバスケットと尾リスクを揃えて返す", () => {
  const errors: string[] = [];
  const { decision, entries } = runQuantumOs(fakeUniverse(14, 200, 3), ENV, errors);

  assert.ok(decision, `決定が返らなかった: ${errors.join(", ")}`);
  assert.equal(errors.length, 0);
  assert.equal(decision!.basket.ids.length, 5);
  assert.equal(decision!.basket.feasible, true);
  assert.equal(decision!.basket.cardinality, 5);

  assert.ok(decision!.risk.varThreshold > 0, "VaR は損失として正");
  assert.ok(decision!.risk.cvar >= decision!.risk.varThreshold - 1e-9, "CVaR ≥ VaR");
  assert.ok(decision!.risk.oracleCalls > 0);
  assert.ok(decision!.risk.classicalSamples > 0);
  assert.equal(decision!.risk.qubits, 6);

  assert.equal(entries.length, 2, "2 問題ぶんの台帳エントリ");
  assert.deepEqual(
    entries.map((e) => e.problem).sort(),
    ["basket-qubo", "tail-amplitude"]
  );
});

test("台帳には古典と量子の両方が必ず並ぶ", () => {
  const { decision } = runQuantumOs(fakeUniverse(12, 200, 4), ENV, []);
  assert.ok(decision);
  for (const entry of decision!.ledgerEntries) {
    const kinds = new Set(entry.runs.map((r) => r.kind));
    assert.ok(kinds.has("classical"), `${entry.problem} に古典バックエンドが無い`);
    assert.ok(kinds.has("quantum-sim"), `${entry.problem} に量子バックエンドが無い`);
  }
});

test("量子OSの出力はそのまま JSON にできる (Durable Object に入る形)", () => {
  const { decision } = runQuantumOs(fakeUniverse(12, 200, 5), ENV, []);
  assert.ok(decision);

  const text = JSON.stringify(decision);
  const round = JSON.parse(text) as typeof decision;
  // 直列化が冪等 = Float64Array や Map など「JSON を通ると形が変わる」型が
  // 紛れ込んでいないこと (undefined なプロパティが落ちるのは JSON の正常な挙動)
  assert.equal(JSON.stringify(round), text);

  // 数値はすべて有限。NaN / Infinity は JSON では null になり、
  // ダッシュボード側で静かに壊れるので、ここで止める。
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "number") {
      assert.ok(Number.isFinite(v), `非有限値: ${path} = ${v}`);
    } else if (v === null) {
      assert.ok(
        path.endsWith(".matchesExact"),
        `null が想定外の位置にある (NaN/Infinity の直列化結果かもしれない): ${path}`
      );
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(round, "decision");
});

test("データが足りなければ null を返して理由を残す (握りつぶさない)", () => {
  const errors: string[] = [];
  // 系列長 120 未満のセクターしかない
  const { decision, entries } = runQuantumOs(fakeUniverse(10, 50, 6), ENV, errors);
  assert.equal(decision, null);
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /insufficient-data/);
});

test("セクター数が基数に足りなければ実行しない", () => {
  const errors: string[] = [];
  const { decision } = runQuantumOs(fakeUniverse(4, 200, 7), ENV, errors);
  assert.equal(decision, null);
  assert.match(errors[0], /insufficient-data/);
});

test("環境変数が未設定でも既定値で動く", () => {
  const errors: string[] = [];
  const { decision } = runQuantumOs(fakeUniverse(12, 200, 8), {}, errors);
  assert.ok(decision, errors.join(", "));
  assert.equal(decision!.basket.cardinality, 5, "既定の K=5");
  assert.equal(decision!.risk.epsilon, 0.01, "既定の ε=0.01");
});

test("環境変数が壊れていても既定値にフォールバックする", () => {
  const { decision } = runQuantumOs(fakeUniverse(12, 200, 9), {
    QUANTUM_BUDGET_MS: "なんかおかしい値",
    BASKET_CARDINALITY: "-3",
    TAIL_EPSILON: "0",
  }, []);
  assert.ok(decision);
  assert.equal(decision!.basket.cardinality, 5);
  assert.equal(decision!.budgetMs, 120);
});

test("CPU 予算が極小でも決定は返る (縮退はするが落ちない)", () => {
  const errors: string[] = [];
  const { decision } = runQuantumOs(fakeUniverse(12, 200, 10), {
    ...ENV,
    QUANTUM_BUDGET_MS: "1",
  }, errors);
  assert.ok(decision, errors.join(", "));
  assert.equal(decision!.basket.ids.length, 5);
});

test("基数を変えると選択本数もついてくる", () => {
  for (const K of [2, 4, 7]) {
    const { decision } = runQuantumOs(fakeUniverse(14, 200, 11), {
      ...ENV,
      BASKET_CARDINALITY: String(K),
    }, []);
    assert.ok(decision);
    assert.equal(decision!.basket.ids.length, K);
  }
});

test("量子推定は真のテール確率に ε 以内で一致する", () => {
  const { decision } = runQuantumOs(fakeUniverse(14, 250, 12), ENV, []);
  assert.ok(decision);
  const { tailProbability, quantumEstimate, epsilon } = decision!.risk;
  assert.ok(
    Math.abs(quantumEstimate - tailProbability) <= epsilon + 1e-9,
    `量子 ${quantumEstimate} vs 真値 ${tailProbability} (ε=${epsilon})`
  );
});

test("厳密解が取れる規模では採用解が厳密解と一致する", () => {
  const { decision } = runQuantumOs(fakeUniverse(14, 250, 13), ENV, []);
  assert.ok(decision);
  assert.equal(decision!.basket.matchesExact, true);
});

test("スケーリングの壁が数値として出る (現状で止まらない)", () => {
  const { decision } = runQuantumOs(fakeUniverse(14, 250, 14), ENV, []);
  assert.ok(decision);
  assert.ok(
    decision!.exactEnumerationWallAt > 14,
    "現在の n より先に壁があること"
  );
});
