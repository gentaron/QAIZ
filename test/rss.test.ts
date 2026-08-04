import test from "node:test";
import assert from "node:assert/strict";

import { parseFeed } from "../src/datasources/rss.ts";

// parseFeed は **第三者が本文を書ける入力** を解析する唯一の純粋関数。
// RSS 6 フィードの中身は QAIZ の管理下になく、壊れた XML も敵対的な XML も届く。
// ここが例外を投げるとパイプライン全体が 1 フィードのせいで止まるので、
// 「何が来ても NewsItem[] を返す」ことを固定する。

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>${items}</channel></rss>`;

const item = (inner: string) => `<item>${inner}</item>`;

test("RSS の item から title / link / pubDate を取り出す", () => {
  const xml = rss(
    item(
      "<title>Tech stocks surge</title>" +
        "<link>https://example.com/a</link>" +
        "<pubDate>Mon, 04 Aug 2026 09:00:00 GMT</pubDate>"
    )
  );
  const out = parseFeed(xml, "example");
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    title: "Tech stocks surge",
    link: "https://example.com/a",
    pubDate: "Mon, 04 Aug 2026 09:00:00 GMT",
    source: "example",
  });
});

test("Atom の entry と <link href> 形式にも対応する", () => {
  const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Market update</title>
    <link href="https://example.com/atom" rel="alternate"/>
    <published>2026-08-04T09:00:00Z</published>
  </entry>
</feed>`;
  const out = parseFeed(xml, "atom");
  assert.equal(out.length, 1);
  assert.equal(out[0].link, "https://example.com/atom");
  assert.equal(out[0].pubDate, "2026-08-04T09:00:00Z");
});

test("pubDate は pubDate → published → updated の順で拾う", () => {
  const only = (tag: string, value: string) =>
    parseFeed(rss(item(`<title>T</title><${tag}>${value}</${tag}>`)), "s")[0]
      .pubDate;
  assert.equal(only("pubDate", "A"), "A");
  assert.equal(only("published", "B"), "B");
  assert.equal(only("updated", "C"), "C");
});

test("CDATA と HTML エンティティを展開する", () => {
  const xml = rss(
    item("<title><![CDATA[AT&amp;T &quot;up&quot; &#39;5%&#39;]]></title>")
  );
  const out = parseFeed(xml, "s");
  assert.equal(out[0].title, "AT&T \"up\" '5%'");
});

test("エンティティで隠したタグも除去される（復号 → タグ除去 の順）", () => {
  // decodeEntities は &lt; &gt; を復号した「あと」に /<[^>]+>/g を掛ける。
  // そのため &lt;script&gt; のようにエンティティで隠したマークアップも
  // 最終的に落ちる。ダッシュボードは見出しを描画するので、この順序が
  // 逆になると「エンティティ経由なら通る」抜け道ができる。
  const xml = rss(
    item("<title>News &lt;script&gt;alert(1)&lt;/script&gt; here</title>")
  );
  const title = parseFeed(xml, "s")[0].title;
  assert.ok(!title.includes("<"), `< が残っている: ${title}`);
  assert.ok(!title.includes(">"), `> が残っている: ${title}`);
  assert.ok(!title.toLowerCase().includes("script"), `script が残っている: ${title}`);
});

test("タイトルに埋め込まれたタグを落とす", () => {
  // ダッシュボードは見出しをそのまま描画する。ここでタグが残ると
  // フィード提供元がマークアップを注入できることになる。
  const xml = rss(item("<title>Stocks <b>surge</b> today</title>"));
  assert.equal(parseFeed(xml, "s")[0].title, "Stocks surge today");
});

test("script タグを含む見出しからタグを除去する", () => {
  const xml = rss(
    item("<title><![CDATA[News <script>alert(1)</script> here]]></title>")
  );
  const title = parseFeed(xml, "s")[0].title;
  assert.ok(!title.includes("<script"), `タグが残っている: ${title}`);
  assert.ok(!title.includes("</script>"), `タグが残っている: ${title}`);
});

test("title の無い item は捨てる", () => {
  const xml = rss(
    item("<link>https://example.com/no-title</link>") +
      item("<title>Kept</title><link>https://example.com/ok</link>")
  );
  const out = parseFeed(xml, "s");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Kept");
});

test("link が無くても空文字で通す（見出しだけでも価値がある）", () => {
  const out = parseFeed(rss(item("<title>No link</title>")), "s");
  assert.equal(out.length, 1);
  assert.equal(out[0].link, "");
});

test("limit で件数を打ち切る", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    item(`<title>Item ${i}</title>`)
  ).join("");
  assert.equal(parseFeed(rss(many), "s").length, 12, "既定は 12 件");
  assert.equal(parseFeed(rss(many), "s", 5).length, 5);
  assert.equal(parseFeed(rss(many), "s", 0).length, 0);
});

test("壊れた入力でも例外を投げず空配列を返す", () => {
  // 1 フィードの破損でパイプライン全体を落とさないための性質。
  for (const bad of [
    "",
    "not xml at all",
    "<rss><channel>",
    "<item><title>unclosed",
    "<html><body>404 Not Found</body></html>",
    "{}",
  ]) {
    const out = parseFeed(bad, "s");
    assert.ok(Array.isArray(out), `配列でない: ${bad}`);
    assert.equal(out.length, 0, `空でない: ${bad}`);
  }
});

test("source は呼び出し側の指定をそのまま載せる", () => {
  const out = parseFeed(rss(item("<title>T</title>")), "Yahoo Finance");
  assert.equal(out[0].source, "Yahoo Finance");
});

test("大文字小文字が混ざったタグ名でも拾う", () => {
  const xml = `<rss><channel><ITEM><Title>Mixed case</Title></ITEM></channel></rss>`;
  const out = parseFeed(xml, "s");
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Mixed case");
});

test("属性付きの item / title でも壊れない", () => {
  const xml = `<rss><channel><item xml:base="https://x/"><title type="html">Attr title</title></item></channel></rss>`;
  assert.equal(parseFeed(xml, "s")[0].title, "Attr title");
});

test("同じ入力なら常に同じ結果", () => {
  const xml = rss(item("<title>Stable</title><link>https://e/1</link>"));
  assert.deepEqual(parseFeed(xml, "s"), parseFeed(xml, "s"));
});
