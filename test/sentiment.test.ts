import test from "node:test";
import assert from "node:assert/strict";

import { lexiconSentiment } from "../src/ai/sentiment.ts";

// lexiconSentiment は Workers AI の無料枠を超えたときに使われる最後の砦。
// 「AI が落ちても数字が出続ける」ことがこのリポジトリの 0 円運用の前提なので、
// ここが壊れると障害が静かに全体へ波及する。

test("見出しが無ければ中立", () => {
  const s = lexiconSentiment([]);
  assert.equal(s.score, 0);
  assert.equal(s.label, "neutral");
  assert.equal(s.headlineCount, 0);
  assert.equal(s.method, "lexicon");
});

test("語彙にかからない見出しは中立 (ゼロ除算を踏まない)", () => {
  const s = lexiconSentiment(["Company announces quarterly conference schedule"]);
  assert.equal(s.score, 0);
  assert.equal(s.label, "neutral");
  assert.equal(s.headlineCount, 1);
});

test("強気な見出しは正、弱気な見出しは負", () => {
  assert.ok(lexiconSentiment(["Tech stocks surge to record high"]).score > 0);
  assert.ok(lexiconSentiment(["Markets plunge on recession fear"]).score < 0);
});

test("日本語の見出しも拾う", () => {
  // RSS は英語 4 本と日本語 2 本の混成。日本語側が拾えないと、
  // 日本株セクターだけ常に中立になる。
  assert.ok(lexiconSentiment(["日経平均が最高値を更新、好調な増益"]).score > 0);
  assert.ok(lexiconSentiment(["世界同時株安、景気減速への懸念で暴落"]).score < 0);
});

test("大文字小文字を区別しない", () => {
  assert.equal(
    lexiconSentiment(["TECH STOCKS SURGE"]).score,
    lexiconSentiment(["tech stocks surge"]).score
  );
});

test("スコアは常に [-1, 1] で小数第 2 位に丸められる", () => {
  const corpus = [
    [],
    ["surge rally soar jump gain beat record boom"],
    ["plunge crash fall drop slump miss fear recession"],
    ["surge and plunge in the same headline"],
    Array.from({ length: 50 }, (_, i) => (i % 2 ? "record profit" : "sharp decline")),
  ];
  for (const headlines of corpus) {
    const s = lexiconSentiment(headlines.flat());
    assert.ok(s.score >= -1 && s.score <= 1, `score=${s.score} が範囲外`);
    assert.equal(s.score, Math.round(s.score * 100) / 100, "丸めが効いていない");
    assert.ok(Number.isFinite(s.score));
  }
});

test("強気語と弱気語が拮抗すると中立に寄る", () => {
  const s = lexiconSentiment(["Stocks surge then plunge on mixed signals"]);
  assert.equal(s.score, 0);
  assert.equal(s.label, "neutral");
});

test("label は score の閾値 ±0.15 と整合する", () => {
  for (const headlines of [
    ["record high profit growth"],
    ["recession fear warning loss"],
    ["surge plunge"],
    ["neutral wording only"],
  ]) {
    const s = lexiconSentiment(headlines);
    const expected =
      s.score > 0.15 ? "bullish" : s.score < -0.15 ? "bearish" : "neutral";
    assert.equal(s.label, expected, `score=${s.score} に対する label が不整合`);
  }
});

test("headlineCount は入力件数をそのまま返す", () => {
  const headlines = ["a", "b", "c", "surge"];
  assert.equal(lexiconSentiment(headlines).headlineCount, 4);
});

test("method は常に lexicon (フォールバック経由だと分かること)", () => {
  // ダッシュボードで「AI が使われたのか、枠切れで語彙に落ちたのか」を
  // 見分けるためのフィールド。ここが揺れると運用の判断材料が消える。
  assert.equal(lexiconSentiment(["surge"]).method, "lexicon");
  assert.equal(lexiconSentiment([]).method, "lexicon");
});
