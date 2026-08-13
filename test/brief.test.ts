import test from "node:test";
import assert from "node:assert/strict";

import {
  contextLines,
  extractJsonObject,
  normalizeSectors,
  parseBriefResponse,
  ruleBasedBrief,
} from "../src/ai/brief.ts";
import type { BriefContext } from "../src/ai/brief.ts";
import { FetchBudget } from "../src/datasources/http.ts";
import type { NewsItem } from "../src/types.ts";

/*
 * 概況の要約は「AI が落ちても画面が空にならない」ことが前提の機能。
 * 8B クラスのモデルは前置き・コードフェンス・壊れた JSON を平気で返すので、
 * パーサが落ちた瞬間に概況パネルが消える設計にしてはいけない。
 * ここではその境界だけを固めておく。
 */

const ctx: BriefContext = {
  regime: {
    asOf: "2026-08-05T00:00:00.000Z",
    trend: "bull",
    trendConfidence: 0.8,
    volatility: "normal",
    riskAppetite: "risk-on",
    evidence: [{ name: "S&P500 対 200日線", value: 0.08, reading: "200日線の上 (上昇基調)" }],
    playbook: [],
  },
  breadth: [
    {
      scope: "グローバル",
      count: 100,
      pctAbove50dma: 70,
      pctAbove200dma: 65,
      advancers: 70,
      decliners: 30,
      advanceDeclineRatio: 2.33,
      newHighs52w: 5,
      newLows52w: 1,
      meanRsi: 57,
      label: "broad-rally",
    },
  ],
  sectors: [],
};

const news = (titles: string[]): NewsItem[] =>
  titles.map((title, i) => ({
    title,
    link: "https://example.com/",
    pubDate: "Thu, 06 Aug 2026 07:00:00 GMT",
    source: ["Yahoo Finance", "CNBC Markets", "NHK 経済"][i % 3],
  }));

/* ------------------------------------------------------------------ */
/* JSON の切り出し                                                     */
/* ------------------------------------------------------------------ */

test("JSON切り出し: 素の JSON をそのまま読む", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test("JSON切り出し: 前置きとコードフェンスを剥がす", () => {
  // 8B モデルが最も高頻度でやる 2 パターン
  assert.deepEqual(extractJsonObject('Here is the JSON:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('了解しました。\n{"a":1}\nご確認ください。'), { a: 1 });
});

test("JSON切り出し: 入れ子の括弧を数え違えない", () => {
  const v = extractJsonObject('prefix {"a":{"b":[{"c":2}]},"d":3} suffix') as Record<string, unknown>;
  assert.deepEqual(v, { a: { b: [{ c: 2 }] }, d: 3 });
});

test("JSON切り出し: 文字列リテラル中の括弧を構造と誤認しない", () => {
  // これを見落とすと、本文に "{" を含む要約が来たときだけ壊れる
  const v = extractJsonObject('{"headline":"利上げ {保留} の公算","n":1}') as Record<string, unknown>;
  assert.deepEqual(v, { headline: "利上げ {保留} の公算", n: 1 });
});

test("JSON切り出し: エスケープされた引用符を跨いでも壊れない", () => {
  const v = extractJsonObject('{"t":"彼は \\"買い\\" と述べた}","n":2}') as Record<string, unknown>;
  assert.deepEqual(v, { t: '彼は "買い" と述べた}', n: 2 });
});

test("JSON切り出し: 壊れた出力では例外を投げずに null を返す", () => {
  for (const bad of ["", "no json here", "{unclosed", '{"a":}', "{{{"]) {
    assert.equal(extractJsonObject(bad), null, `入力: ${bad}`);
  }
});

/* ------------------------------------------------------------------ */
/* セクター名の正規化                                                  */
/* ------------------------------------------------------------------ */

test("セクター正規化: ID・日本語名・英語名のどれでも拾う", () => {
  assert.deepEqual(normalizeSectors(["semis"]), ["semis"]);
  assert.deepEqual(normalizeSectors(["半導体"]), ["semis"]);
  assert.deepEqual(normalizeSectors(["Semiconductors"]), ["semis"]);
});

test("セクター正規化: 未知の名前は黙って捨てる (でっち上げない)", () => {
  assert.deepEqual(normalizeSectors(["宇宙エレベーター", "semis", ""]), ["semis"]);
  assert.deepEqual(normalizeSectors("semis"), []);
  assert.deepEqual(normalizeSectors(null), []);
});

test("セクター正規化: 重複を落とし、4 件で打ち切る", () => {
  assert.deepEqual(normalizeSectors(["semis", "半導体"]), ["semis"]);
  assert.equal(
    normalizeSectors(["semis", "tech", "energy", "banks", "health", "gold"]).length,
    4
  );
});

/* ------------------------------------------------------------------ */
/* 応答のパース                                                        */
/* ------------------------------------------------------------------ */

test("応答パース: 期待どおりの JSON を素直に読む", () => {
  const r = parseBriefResponse(
    JSON.stringify({
      headline: "AI設備投資が半導体を牽引",
      summary: ["需要が想定を上回っている", "金利低下も追い風"],
      themes: [
        { title: "AI設備投資", detail: "受注残が積み上がる", impact: "bullish", sectors: ["semis"] },
      ],
      watch: ["米CPI"],
    })
  );
  assert.ok(r);
  assert.equal(r!.headline, "AI設備投資が半導体を牽引");
  assert.equal(r!.summary.length, 2);
  assert.equal(r!.themes[0].impact, "bullish");
  assert.deepEqual(r!.themes[0].sectors, ["semis"]);
  assert.deepEqual(r!.watch, ["米CPI"]);
});

test("応答パース: impact の表記ゆれを 3 値に寄せる", () => {
  const of = (impact: string) =>
    parseBriefResponse(JSON.stringify({ themes: [{ title: "t", impact }] }))!.themes[0].impact;
  assert.equal(of("bullish"), "bullish");
  assert.equal(of("強気"), "bullish");
  assert.equal(of("追い風"), "bullish");
  assert.equal(of("BEARISH"), "bearish");
  assert.equal(of("逆風"), "bearish");
  assert.equal(of("よく分からない"), "mixed");
});

test("応答パース: 別名のキー (points / description) も拾う", () => {
  const r = parseBriefResponse(
    JSON.stringify({ title: "見出し", points: ["本文"], themes: [{ name: "テーマ", description: "説明" }] })
  );
  assert.equal(r!.headline, "見出し");
  assert.deepEqual(r!.summary, ["本文"]);
  assert.equal(r!.themes[0].title, "テーマ");
  assert.equal(r!.themes[0].detail, "説明");
});

test("応答パース: 中身が空なら null (パースできたことにしない)", () => {
  assert.equal(parseBriefResponse("{}"), null);
  assert.equal(parseBriefResponse('{"summary":[]}'), null);
  assert.equal(parseBriefResponse("ごめんなさい、要約できません"), null);
});

test("応答パース: 型が違うフィールドで落ちない", () => {
  const r = parseBriefResponse(
    JSON.stringify({ headline: "見出し", summary: "配列ではない", themes: "配列ではない", watch: 42 })
  );
  assert.ok(r, "落ちてはいけない");
  assert.deepEqual(r!.summary, []);
  assert.deepEqual(r!.themes, []);
  assert.deepEqual(r!.watch, []);
});

test("応答パース: 長すぎる本文とテーマ数を切り詰める", () => {
  const r = parseBriefResponse(
    JSON.stringify({
      headline: "あ".repeat(500),
      summary: Array.from({ length: 20 }, () => "い".repeat(500)),
      themes: Array.from({ length: 20 }, (_, i) => ({ title: `t${i}` })),
    })
  );
  assert.ok(r!.headline.length <= 120);
  assert.ok(r!.summary.length <= 5);
  assert.ok(r!.summary[0].length <= 220);
  assert.ok(r!.themes.length <= 5);
});

/* ------------------------------------------------------------------ */
/* フォールバック                                                      */
/* ------------------------------------------------------------------ */

test("フォールバック: AI 無しでも必ず概況が出る", () => {
  const b = ruleBasedBrief(
    news([
      "Semiconductor demand surges on AI spending",
      "Chip demand beats expectations",
      "Oil price plunge on OPEC supply",
      "Crude slump continues",
    ]),
    ctx,
    "AI 呼び出しに失敗"
  );
  assert.equal(b.method, "rule-based");
  assert.equal(b.model, null);
  assert.ok(b.headline.length > 0);
  assert.ok(b.summary.length >= 2);
  assert.equal(b.headlineCount, 4);
  assert.equal(b.sourceCount, 3);
});

test("フォールバック: 劣化の理由を必ず残す (静かに壊れない)", () => {
  const b = ruleBasedBrief(news(["a", "b"]), ctx, "AI 呼び出しに失敗: TypeError");
  assert.equal(b.degradedReason, "AI 呼び出しに失敗: TypeError");
  // 機械集計であることを本文にも明記する。見た目が同じだと信頼度を測れない
  assert.ok(b.summary.some((s) => s.includes("AI 要約が使えなかった")));
});

test("フォールバック: ニュースが 0 本でも例外を投げない", () => {
  const b = ruleBasedBrief([], ctx, "ニュースを1本も取得できていない");
  assert.equal(b.headlineCount, 0);
  assert.equal(b.sourceCount, 0);
  assert.deepEqual(b.themes, []);
  assert.ok(b.headline.length > 0);
});

test("フォールバック: テーマは見出しが 2 本以上あるセクターだけ", () => {
  const b = ruleBasedBrief(
    news([
      "semiconductor orders rise",
      "chip demand strong",
      "foundry utilization up",
      "single mention of gold price",
    ]),
    ctx,
    ""
  );
  for (const t of b.themes) assert.ok(t.headlineCount >= 2, `${t.title} が 1 本で採用されている`);
  assert.ok(b.themes.some((t) => t.sectors.includes("semis")));
});

test("フォールバック: レジームが無くても組み立てられる", () => {
  const b = ruleBasedBrief(news(["market rally"]), { ...ctx, regime: null }, "");
  assert.ok(b.headline.includes("レジーム未判定"));
});

/* ------------------------------------------------------------------ */
/* プロンプトに渡す実測値                                              */
/* ------------------------------------------------------------------ */

test("コンテキスト: レジームと市場の幅を実測値として渡す", () => {
  const lines = contextLines(ctx);
  assert.ok(lines.some((l) => l.includes("上昇基調") && l.includes("リスクオン")));
  assert.ok(lines.some((l) => l.includes("200日線超え 65%")));
});

test("コンテキスト: 材料が無ければ空で返す (数字をでっち上げない)", () => {
  const lines = contextLines({ regime: null, breadth: [], sectors: [] });
  assert.deepEqual(lines, []);
});

/* ------------------------------------------------------------------ */
/* AI 呼び出し用の予算枠                                               */
/* ------------------------------------------------------------------ */

test("予算の取り置き: 価格取得が先に食い尽くしても AI の枠は残る", () => {
  // これが壊れると、シャードの銘柄数が増えた日から要約が黙って出なくなる。
  const b = new FetchBudget(10, 3);
  let taken = 0;
  while (b.take("chart")) taken++;
  assert.equal(taken, 7, "取り置き分まで通常枠が食っている");
  assert.ok(b.takeReserved("ai-brief"), "取り置き枠が使えない");
  assert.ok(b.takeReserved("ai-sentiment"));
  assert.ok(b.takeReserved("ai-sentiment"));
  assert.equal(b.takeReserved("ai-sentiment"), false, "上限を超えて取れてしまう");
  assert.equal(b.spent, 10);
});

test("予算の取り置き: 使われなかった取り置きは通常枠に流用されない", () => {
  // 流用できるほうが効率は良いが、実行順に依存して AI が動いたり動かなかったり
  // する挙動のほうが運用上たちが悪い。取り置きは固定で良い。
  const b = new FetchBudget(5, 2);
  assert.ok(b.take("a") && b.take("b") && b.take("c"));
  assert.equal(b.take("d"), false);
  assert.ok(b.skipped.includes("d"), "諦めた理由が記録されていない");
});

test("予算の取り置き: 取り置きが上限以上でも通常枠が 1 本は残る", () => {
  const b = new FetchBudget(4, 99);
  assert.equal(b.reserved, 3);
  assert.ok(b.take("rss"), "通常枠が完全に潰れている");
});
