import test from "node:test";
import assert from "node:assert/strict";

import { computeHeatScore } from "../src/engine/scoring.ts";
import type { SentimentResult } from "../src/types.ts";
import { NEUTRAL_COSMO, NEUTRAL_MOMENTUM, NEUTRAL_QUANTUM } from "./helpers.ts";

const sentiment = (score: number): SentimentResult => ({
  score,
  label: score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral",
  headlineCount: 10,
  method: "lexicon",
});

/** 中立入力から一部だけ差し替えてスコアを取る */
function heat(
  over: {
    momentum?: Partial<typeof NEUTRAL_MOMENTUM>;
    quantum?: Partial<typeof NEUTRAL_QUANTUM>;
    cosmo?: Partial<typeof NEUTRAL_COSMO>;
    sentiment?: SentimentResult | null;
  } = {}
): number {
  return computeHeatScore(
    { ...NEUTRAL_MOMENTUM, ...over.momentum },
    { ...NEUTRAL_QUANTUM, ...over.quantum },
    { ...NEUTRAL_COSMO, ...over.cosmo },
    over.sentiment ?? null
  );
}

test("中立な入力はちょうど 50 点 (アンカー)", () => {
  // 何も起きていない銘柄が 50 点であることは、ダッシュボードの
  // 「熱い/冷たい」の読み方そのもの。重みを触ったらここが真っ先に動く。
  assert.equal(heat(), 50);
});

test("スコアは常に [0,100] に収まり、小数第 1 位に丸められる", () => {
  const extremes = [-1e6, -1, -0.1, 0, 0.1, 1, 1e6];
  for (const r of extremes) {
    for (const h of [0, 0.3, 0.5, 0.7, 1]) {
      for (const s of [null, sentiment(-1), sentiment(1)]) {
        const v = heat({
          momentum: { r1w: r, r1m: r, r3m: r, volAdj: r, trendConsistency: h },
          quantum: { fubiniStudy: Math.PI / 2, qfiProxy: Math.abs(r) },
          cosmo: { hurst: h },
          sentiment: s,
        });
        assert.ok(v >= 0 && v <= 100, `heat=${v} が [0,100] の外`);
        assert.equal(v, Math.round(v * 10) / 10, "丸めが効いていない");
      }
    }
  }
});

test("モメンタムに対して単調増加", () => {
  let prev = -Infinity;
  for (const r of [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2]) {
    const v = heat({ momentum: { r1w: r, r1m: r, r3m: r } });
    assert.ok(v >= prev, `r=${r} でスコアが下がった (${prev} -> ${v})`);
    prev = v;
  }
});

test("Hurst のレジーム係数: トレンド持続側ほどモメンタムが増幅される", () => {
  // 上昇モメンタムを持つ銘柄では、H が高いほどスコアが高くなる。
  const up = { r1w: 0.03, r1m: 0.06, r3m: 0.12 };
  const low = heat({ momentum: up, cosmo: { hurst: 0.2 } });
  const mid = heat({ momentum: up, cosmo: { hurst: 0.5 } });
  const high = heat({ momentum: up, cosmo: { hurst: 0.9 } });
  assert.ok(low < mid && mid < high, `${low} < ${mid} < ${high} が成立しない`);
});

test("Hurst の増幅は 0.8〜1.2 倍でクランプされる", () => {
  // hurst が定義域外 (負 / 1 超) でも係数が暴走しないこと。
  const up = { r1w: 0.03, r1m: 0.06, r3m: 0.12 };
  assert.equal(heat({ momentum: up, cosmo: { hurst: -5 } }), heat({ momentum: up, cosmo: { hurst: 0.3 } }));
  assert.equal(heat({ momentum: up, cosmo: { hurst: 5 } }), heat({ momentum: up, cosmo: { hurst: 0.7 } }));
});

test("転換ブースト: Fubini-Study 距離が大きいと直近の方向へシフトする", () => {
  const calm = { fubiniStudy: 0 };
  const shifting = { fubiniStudy: 1.5 };

  // 上昇中の転換 → 加点
  const upCalm = heat({ momentum: { r1w: 0.03 }, quantum: calm });
  const upShift = heat({ momentum: { r1w: 0.03 }, quantum: shifting });
  assert.ok(upShift > upCalm, `上昇時の転換で加点されない (${upCalm} -> ${upShift})`);

  // 下落中の転換 → 減点
  const downCalm = heat({ momentum: { r1w: -0.03 }, quantum: calm });
  const downShift = heat({ momentum: { r1w: -0.03 }, quantum: shifting });
  assert.ok(downShift < downCalm, `下落時の転換で減点されない (${downCalm} -> ${downShift})`);
});

test("転換ブーストは d_FS が 0.6 未満では効かない", () => {
  const base = heat({ momentum: { r1w: 0.03 }, quantum: { fubiniStudy: 0 } });
  assert.equal(heat({ momentum: { r1w: 0.03 }, quantum: { fubiniStudy: 0.5 } }), base);
  assert.equal(heat({ momentum: { r1w: 0.03 }, quantum: { fubiniStudy: 0.6 } }), base);
});

test("転換ブーストの絶対値は 8 点以内", () => {
  const base = heat({ momentum: { r1w: 1 }, quantum: { fubiniStudy: 0 } });
  const boosted = heat({ momentum: { r1w: 1 }, quantum: { fubiniStudy: Math.PI / 2 } });
  assert.ok(boosted - base <= 8 + 1e-9, `ブーストが ${boosted - base} 点`);
});

test("QFI ペナルティ: 感応度が高いほど減点され、上限は 4 点", () => {
  const calm = heat({ quantum: { qfiProxy: 0 } });
  const jittery = heat({ quantum: { qfiProxy: 1 } });
  const saturated = heat({ quantum: { qfiProxy: 2 } });
  const beyond = heat({ quantum: { qfiProxy: 1e6 } });

  assert.ok(jittery < calm, "QFI が上がっても減点されない");
  assert.equal(saturated, 46, "qfiProxy=2 で 50-4=46");
  assert.equal(beyond, saturated, "ペナルティが 4 点で頭打ちになっていない");
});

test("センチメントは ±10 点", () => {
  assert.equal(heat({ sentiment: sentiment(1) }), 60);
  assert.equal(heat({ sentiment: sentiment(-1) }), 40);
  assert.equal(heat({ sentiment: sentiment(0) }), 50);
  assert.equal(heat({ sentiment: null }), 50, "センチメント無しは中立と同じ");
});

test("【前提の固定】入力が有限値であることを scoring は仮定している", () => {
  // clamp01 も Math.round も NaN を素通しするので、NaN が 1 つ混じると
  // そのセクターのヒートスコアは NaN になる。scoring 側に防御はない。
  //
  // これは手抜きではなく、防御の位置が違うだけ:
  //   src/datasources/yahoo.ts — `c != null && Number.isFinite(c)` で除外
  //   src/datasources/stooq.ts — `Number.isFinite(close) && Number.isFinite(t)` で除外
  // 欠損値は境界で捨てられ、エンジンには有限値しか入らない。
  //
  // このテストは「NaN が伝播すること」を仕様として固定するためにある。
  // データソース側の isFinite ガードを外すと、ダッシュボードが NaN で
  // 埋まる — 落とすなら scoring ではなく境界で落とすこと。
  const v = computeHeatScore(
    { r1w: NaN, r1m: 0, r3m: 0, volAdj: 0, trendConsistency: 0.5 },
    NEUTRAL_QUANTUM,
    NEUTRAL_COSMO,
    null
  );
  assert.ok(Number.isNaN(v), "NaN の伝播経路が変わった。意図した変更か確認すること");
});

test("同じ入力なら常に同じスコア", () => {
  const args = {
    momentum: { r1w: 0.021, r1m: 0.037, r3m: 0.089 },
    quantum: { fidelity: 0.4, fubiniStudy: 0.89, qfiProxy: 0.43, entropy: 0.7 },
    cosmo: { hurst: 0.61, spectralSlope: -1.2 },
    sentiment: sentiment(0.3),
  };
  assert.equal(heat(args), heat(args));
});
