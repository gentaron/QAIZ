/**
 * 優位性ベンチマーク。
 *
 *   npm run bench
 *
 * README に載っている数字はすべてこのスクリプトの出力そのもの。
 * 「量子が効く/効かない」を主張の形ではなく **再現可能な表** で出すのが目的。
 *
 * 2 本走らせる:
 *
 *  A. テールリスク推定 — ε を細かくしていったとき、古典が必要とする
 *     サンプル数と IQAE のオラクル呼び出し数がどう乖離するか。
 *     理論は Θ(1/ε²) vs O(1/ε) なので、比は 1/ε に比例して伸びるはず。
 *
 *  B. バスケット選択 — n を増やしたとき、厳密列挙・焼きなまし・QAOA+ が
 *     それぞれ何をどれだけ食うか。ここは量子が勝たない。勝たないことを
 *     数字で見せるのがこのベンチの役目。
 */

import { solveExact, solveQaoa, solveSimulatedAnnealing } from "../src/os/backends.ts";
import { approximationRatio } from "../src/os/kernel.ts";
import { binomial, exactEnumerationWall } from "../src/os/ledger.ts";
import { buildBasketQubo, covarianceMatrix } from "../src/problems/basket.ts";
import { analyzeTailRisk } from "../src/problems/tailrisk.ts";
import { classicalSampleRequirement } from "../src/quantum/iqae.ts";
import { mulberry32 } from "../src/quantum/rng.ts";

const SEED = 20260805;

function syntheticMarket(n: number, T: number, seed: number) {
  const rng = mulberry32(seed);
  const common = Array.from({ length: T }, () => (rng() - 0.5) * 0.022);
  const returns = Array.from({ length: n }, () => {
    const beta = 0.3 + rng();
    const idio = 0.008 + rng() * 0.02;
    return Array.from({ length: T }, (_, t) => beta * common[t] + (rng() - 0.5) * idio);
  });
  const mu = Float64Array.from({ length: n }, () => rng());
  return { returns, mu, sigma: covarianceMatrix(returns) };
}

function row(cells: (string | number)[]): string {
  return "| " + cells.join(" | ") + " |";
}

// ---------------------------------------------------------------- A. 振幅推定

function benchTailRisk(): void {
  console.log("\n## A. テールリスク推定 — 振幅推定 vs モンテカルロ\n");
  console.log(
    "同じ分布・同じ信頼度 (95%) で、目標精度 ε を半分にしていったときの必要クエリ数。\n"
  );
  console.log(
    row(["ε", "古典 必要サンプル (Θ(1/ε²))", "IQAE オラクル呼び出し (O(1/ε))", "比", "IQAE 誤差", "ラウンド"])
  );
  console.log(row(["---:", "---:", "---:", "---:", "---:", "---:"]));

  const { returns } = syntheticMarket(6, 600, SEED);
  const basket = returns[0].map(
    (_, t) => returns.reduce((s, r) => s + r[t], 0) / returns.length
  );

  const rows: { eps: number; ratio: number }[] = [];
  for (const eps of [0.04, 0.02, 0.01, 0.005, 0.0025]) {
    const r = analyzeTailRisk({ returns: basket, epsilon: eps, bins: 32, seed: SEED });
    const ratio = r.classical.requiredSamples / r.quantum.oracleCalls;
    rows.push({ eps, ratio });
    console.log(
      row([
        eps,
        r.classical.requiredSamples.toLocaleString(),
        r.quantum.oracleCalls.toLocaleString(),
        "×" + ratio.toFixed(2),
        Math.abs(r.quantum.estimate - r.exactTailProbability).toFixed(5),
        r.quantum.rounds,
      ])
    );
  }

  // log-log 回帰で「比 ∝ 1/ε^s」の指数 s を推定する。理論値は s=1。
  const xs = rows.map((r) => Math.log(1 / r.eps));
  const ys = rows.map((r) => Math.log(r.ratio));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = num / den;
  console.log(
    `\n比の log-log 回帰の傾き = ${slope.toFixed(3)} ` +
      `(理論値 1.0 = 古典 Θ(1/ε²) と量子 O(1/ε) の差そのもの)`
  );
  console.log(
    "→ **クエリ計算量では量子が二次で優位**。ただしこれは実機がそのまま引き継ぐ量であって、\n" +
      "  シミュレータの実行時間ではない (状態ベクトルは 2ⁿ なので壁時計では必ず古典が勝つ)。"
  );
}

// ---------------------------------------------------------------- B. 組合せ最適化

function benchBasket(): void {
  console.log("\n## B. 基数制約付きバスケット選択 — 厳密 vs 焼きなまし vs QAOA+\n");
  console.log(
    row(["n", "K", "候補数", "厳密 (ms)", "SA (ms)", "QAOA+ (ms)", "SA 近似比", "QAOA+ 近似比"])
  );
  console.log(row(["---:", "---:", "---:", "---:", "---:", "---:", "---:", "---:"]));

  for (const n of [8, 10, 12, 14, 16]) {
    const K = Math.max(2, Math.round(n / 3));
    const { mu, sigma } = syntheticMarket(n, 250, SEED + n);
    const ids = Array.from({ length: n }, (_, i) => `A${i}`);
    const qubo = buildBasketQubo({
      ids,
      mu,
      sigma,
      cardinality: K,
      riskAversion: 200,
      penalty: 0,
    });

    const exact = solveExact(qubo, K, { budgetMs: 60_000 });
    const sa = solveSimulatedAnnealing(qubo, K, { budgetMs: 2000, seed: SEED });
    const qaoa = solveQaoa(qubo, K, {
      budgetMs: 5000,
      seed: SEED,
      layers: 3,
      maxQubits: 18,
    });

    console.log(
      row([
        n,
        K,
        Math.round(binomial(n, K)).toLocaleString(),
        exact.run.wallMs.toFixed(1),
        sa.run.wallMs.toFixed(1),
        qaoa.run.ok ? qaoa.run.wallMs.toFixed(1) : "skip",
        approximationRatio(exact.energy, sa.energy, exact.worstEnergy).toFixed(4),
        qaoa.run.ok
          ? approximationRatio(exact.energy, qaoa.energy, exact.worstEnergy).toFixed(4)
          : "—",
      ])
    );
  }

  console.log(
    `\n→ この規模では **量子的優位は存在しない**。厳密解が数ミリ秒で出るし、\n` +
      `  QAOA+ が最適解に届いてもそれは「厳密解の再現」でしかない。\n` +
      `  厳密列挙が 10⁹ 候補を超えるのは K=n/3 のとき n = ${exactEnumerationWall(
        Math.round(30 / 3)
      )} 付近 (K=10 換算)。\n` +
      `  そこから先が本来の勝負どころだが、状態ベクトルシミュレータも同時に破綻するので、\n` +
      `  検証には実機が要る。QAIZ が QPU アダプタを持っているのはそのため。`
  );
}

console.log("# QAIZ 優位性ベンチマーク");
console.log(`\nseed=${SEED} / Node ${process.version} / ${new Date().toISOString()}`);
benchTailRisk();
benchBasket();
console.log(
  "\n---\n**結論**: 量子が現時点で勝てるのは振幅推定 (クエリ計算量) だけ。" +
    "組合せ最適化側は今の規模では負ける。QAIZ はこの両方を毎時測り続けて台帳に残す。"
);
