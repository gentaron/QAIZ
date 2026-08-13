import type {
  Breadth,
  Env,
  NewsBrief,
  NewsItem,
  NewsTheme,
  Regime,
  SectorAggregate,
  SectorId,
} from "../types.ts";
import { SECTOR_META, SECTOR_ORDER } from "../config/sectors.ts";
import { lexiconSentiment, matchHeadlines } from "./sentiment.ts";

/**
 * ニュース概況の要約。
 *
 * 見出しをそのまま 24 本並べても「何がどうなっているか」は分からない。
 * ここでは見出しをテーマに束ね、影響先セクターと向きまで書き下す。
 *
 * 経路は 2 本:
 *   1. Workers AI (Llama 3.1 8B) に相場の観測値ごと渡して日本語で要約させる
 *   2. AI が使えない / 壊れた JSON を返した場合は、キーワード集計で組み立てる
 *
 * どちらで出したかは method に必ず残す。生成文と機械集計を同じ見た目で
 * 出すと、読み手が信頼度を測れなくなる。degradedReason には
 * 「なぜ AI を使わなかったか」を残し、静かな劣化を作らない。
 */

/** 要約に渡す見出しの上限。多すぎるとモデルが後半を無視する */
const MAX_HEADLINES = 22;

/* ------------------------------------------------------------------ */
/* JSON パース                                                         */
/* ------------------------------------------------------------------ */

/**
 * LLM の出力から最初の JSON オブジェクトを取り出す。
 *
 * 8B クラスのモデルは前置き ("Here is the JSON:") やコードフェンスを
 * 平気で付けてくる。JSON.parse をそのまま呼ぶと必ず落ちるので、
 * 波括弧の対応を数えて 1 個目のオブジェクトだけを切り出す。
 * 文字列リテラル中の括弧を数えないよう、クォート状態も見る。
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const str = (v: unknown, max = 220): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

function strList(v: unknown, maxItems: number, maxLen = 220): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems);
}

/** モデルが返したセクター名を SectorId に寄せる (未知は捨てる) */
export function normalizeSectors(v: unknown): SectorId[] {
  if (!Array.isArray(v)) return [];
  const out: SectorId[] = [];
  for (const raw of v) {
    const s = str(raw, 40).toLowerCase();
    if (!s) continue;
    const hit = SECTOR_ORDER.find(
      (id) =>
        id === s ||
        SECTOR_META[id].nameJa === str(raw, 40) ||
        SECTOR_META[id].nameEn.toLowerCase() === s
    );
    if (hit && !out.includes(hit)) out.push(hit);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeImpact(v: unknown): NewsTheme["impact"] {
  const s = str(v, 20).toLowerCase();
  if (s.includes("bull") || s.includes("強気") || s.includes("追い風")) return "bullish";
  if (s.includes("bear") || s.includes("弱気") || s.includes("逆風")) return "bearish";
  return "mixed";
}

/**
 * モデル出力を NewsBrief の形に整える。
 * 欠けているフィールドは埋めず、呼び出し側が「AI は使えたが中身が薄い」
 * ことを判断できるように空のまま返す。
 */
export function parseBriefResponse(raw: string): {
  headline: string;
  summary: string[];
  themes: NewsTheme[];
  watch: string[];
} | null {
  const obj = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;

  const headline = str(obj.headline ?? obj.title, 120);
  const summary = strList(obj.summary ?? obj.points, 5, 220);
  const watch = strList(obj.watch ?? obj.watchlist, 4, 160);

  const themesRaw = Array.isArray(obj.themes) ? obj.themes : [];
  const themes: NewsTheme[] = themesRaw
    .slice(0, 5)
    .map((t) => {
      const o = (t ?? {}) as Record<string, unknown>;
      return {
        title: str(o.title ?? o.name, 60),
        detail: str(o.detail ?? o.description, 220),
        impact: normalizeImpact(o.impact ?? o.direction),
        sectors: normalizeSectors(o.sectors),
        headlineCount: 0,
      };
    })
    .filter((t) => t.title.length > 0);

  // 見出しも本文もテーマも空なら「パースできた」とは言えない
  if (!headline && summary.length === 0 && themes.length === 0) return null;
  return { headline, summary, themes, watch };
}

/* ------------------------------------------------------------------ */
/* 市況コンテキスト (プロンプトに埋める観測値)                          */
/* ------------------------------------------------------------------ */

export interface BriefContext {
  regime: Regime | null;
  breadth: Breadth[];
  sectors: SectorAggregate[];
}

/**
 * モデルに渡す市況の要約。
 *
 * 見出しだけ渡すと「株価は動いています」レベルの文章しか返ってこない。
 * レジーム・幅・セクターの実測値を添えて、ニュースと数字を突き合わせた
 * 文章を書かせる。数字はこちらで計算済みのものだけを渡す
 * (モデルに計算させると必ず間違える)。
 */
export function contextLines(ctx: BriefContext): string[] {
  const out: string[] = [];
  const r = ctx.regime;
  if (r) {
    const trend = { bull: "上昇基調", bear: "下降基調", range: "レンジ" }[r.trend];
    const vol = { low: "低ボラ", normal: "平常", elevated: "警戒", stress: "ストレス" }[r.volatility];
    const app = { "risk-on": "リスクオン", neutral: "中立", "risk-off": "リスクオフ" }[r.riskAppetite];
    out.push(`相場レジーム: ${trend} / ボラ ${vol} / ${app}`);
    for (const e of r.evidence.slice(0, 5)) out.push(`  ${e.name}: ${e.reading}`);
  }
  const g = ctx.breadth.find((b) => b.scope === "グローバル") ?? ctx.breadth[0];
  if (g) {
    out.push(
      `市場の幅 (${g.scope}): 200日線超え ${g.pctAbove200dma ?? "?"}% / 上昇 ${g.advancers} 対 下落 ${g.decliners}`
    );
  }

  const ranked = ctx.sectors
    .filter((s) => typeof s.r1w === "number")
    .sort((a, b) => (b.r1w ?? 0) - (a.r1w ?? 0));
  const fmt = (s: SectorAggregate) =>
    `${s.nameJa} ${((s.r1w ?? 0) * 100).toFixed(1)}%`;
  if (ranked.length >= 4) {
    out.push(`直近1週で強いセクター: ${ranked.slice(0, 4).map(fmt).join(" / ")}`);
    out.push(`直近1週で弱いセクター: ${ranked.slice(-4).reverse().map(fmt).join(" / ")}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ルールベースのフォールバック                                        */
/* ------------------------------------------------------------------ */

/**
 * AI 抜きで組み立てる概況。
 *
 * やっていることは「セクターのキーワードに当たった見出しを数え、
 * 語彙センチメントで向きを付ける」だけ。文章の滑らかさは AI に劣るが、
 * 事実 (件数と語彙の内訳) しか書かないので嘘は混ざらない。
 */
export function ruleBasedBrief(
  news: NewsItem[],
  ctx: BriefContext,
  degradedReason: string
): NewsBrief {
  const sources = new Set(news.map((n) => n.source));

  const scored = SECTOR_ORDER.filter((id) => id !== "broad" && id !== "macro")
    .map((id) => {
      const heads = matchHeadlines(news, SECTOR_META[id].keywords, 8);
      return { id, heads, sentiment: lexiconSentiment(heads) };
    })
    .filter((x) => x.heads.length >= 2)
    .sort((a, b) => b.heads.length - a.heads.length);

  const themes: NewsTheme[] = scored.slice(0, 4).map((x) => ({
    title: SECTOR_META[x.id].nameJa,
    detail:
      `関連する見出しが ${x.heads.length} 本。語彙判定のセンチメントは ${x.sentiment.score.toFixed(2)}。` +
      `代表的な見出し: ${x.heads[0]}`,
    impact:
      x.sentiment.label === "bullish"
        ? "bullish"
        : x.sentiment.label === "bearish"
          ? "bearish"
          : "mixed",
    sectors: [x.id],
    headlineCount: x.heads.length,
  }));

  const overall = lexiconSentiment(news.map((n) => n.title));
  const r = ctx.regime;
  const regimeWord = r
    ? `${{ bull: "上昇基調", bear: "下降基調", range: "レンジ" }[r.trend]}・${
        { "risk-on": "リスクオン", neutral: "中立", "risk-off": "リスクオフ" }[r.riskAppetite]
      }`
    : "レジーム未判定";

  const summary: string[] = [
    `見出し ${news.length} 本を ${sources.size} 媒体から取得。語彙判定の全体センチメントは ${overall.score.toFixed(2)} (${
      { bullish: "強気寄り", bearish: "弱気寄り", neutral: "中立" }[overall.label]
    })。`,
    `相場地形は ${regimeWord}。`,
  ];
  if (themes.length > 0) {
    summary.push(
      `見出しが集中しているのは ${themes.map((t) => `${t.title} (${t.headlineCount}本)`).join("、")}。`
    );
  }
  summary.push(
    "※ AI 要約が使えなかったため、キーワード一致と語彙センチメントによる機械集計を表示している。文意の解釈は行っていない。"
  );

  return {
    asOf: new Date().toISOString(),
    method: "rule-based",
    model: null,
    headline: `${regimeWord}。見出しは ${
      { bullish: "強気", bearish: "弱気", neutral: "中立" }[overall.label]
    }寄り (${news.length}本)`,
    summary,
    themes,
    watch: scored.slice(0, 3).map((x) => `${SECTOR_META[x.id].nameJa} 関連の続報`),
    headlineCount: news.length,
    sourceCount: sources.size,
    degradedReason,
  };
}

/* ------------------------------------------------------------------ */
/* AI 経路                                                             */
/* ------------------------------------------------------------------ */

function buildPrompt(news: NewsItem[], ctx: BriefContext): string {
  const heads = news.slice(0, MAX_HEADLINES);
  const sectorList = SECTOR_ORDER.filter((id) => id !== "broad" && id !== "macro")
    .map((id) => `${id} (${SECTOR_META[id].nameJa})`)
    .join(", ");

  return [
    "あなたは機関投資家向けのマーケットストラテジストです。",
    "以下の「相場の実測値」と「直近のニュース見出し」を突き合わせ、いま市場で何がどうなっているのかを日本語で要約してください。",
    "",
    "## 制約",
    "- 実測値として与えられた数字だけを使うこと。自分で株価や指標を推測して書かないこと。",
    "- 見出しに書かれていない出来事を作らないこと。根拠が弱いことは「〜の可能性」と明示すること。",
    "- 個別銘柄の売買推奨は書かないこと。セクター単位の影響にとどめること。",
    "- 出力は JSON オブジェクトのみ。前後に説明文やコードフェンスを付けないこと。",
    "",
    "## 出力する JSON の形",
    "{",
    '  "headline": "いまの相場を一行で (40字以内)",',
    '  "summary": ["何がどうなっているかを3〜4行。1行80字以内"],',
    '  "themes": [{"title":"テーマ名","detail":"内容と影響 (120字以内)","impact":"bullish|bearish|mixed","sectors":["セクターID"]}],',
    '  "watch": ["次に確認すべき材料を2〜3個"]',
    "}",
    "",
    `sectors に使えるIDは次のみ: ${sectorList}`,
    "",
    "## 相場の実測値",
    ...contextLines(ctx),
    "",
    "## 直近のニュース見出し",
    ...heads.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`),
  ].join("\n");
}

/** テーマに紐づく見出し数を後から数える (モデルの自己申告は当てにしない) */
function countThemeHeadlines(themes: NewsTheme[], news: NewsItem[]): NewsTheme[] {
  return themes.map((t) => {
    const keywords = t.sectors.flatMap((s) => SECTOR_META[s]?.keywords ?? []);
    return {
      ...t,
      headlineCount: keywords.length > 0 ? matchHeadlines(news, keywords, 20).length : 0,
    };
  });
}

/**
 * ニュース概況を生成する。AI が失敗しても必ず NewsBrief を返す。
 * 例外は投げない — この関数が落ちるとパイプライン全体が止まるため。
 */
export async function generateNewsBrief(
  env: Env,
  news: NewsItem[],
  ctx: BriefContext
): Promise<NewsBrief> {
  if (news.length === 0) {
    return ruleBasedBrief(news, ctx, "ニュースを1本も取得できていない");
  }

  let reason = "";
  try {
    const result = (await env.AI.run(env.SENTIMENT_MODEL as keyof AiModels, {
      messages: [{ role: "user", content: buildPrompt(news, ctx) }],
      max_tokens: 700,
      temperature: 0.2,
    } as never)) as { response?: string };

    const parsed = parseBriefResponse(result.response ?? "");
    if (parsed) {
      const sources = new Set(news.map((n) => n.source));
      const fallback = ruleBasedBrief(news, ctx, "");
      return {
        asOf: new Date().toISOString(),
        method: "workers-ai",
        model: env.SENTIMENT_MODEL,
        // モデルが一部しか埋めなかった項目は機械集計で補う。
        // 空欄のまま出すより、出所の違う値でも埋まっているほうが読める。
        headline: parsed.headline || fallback.headline,
        summary: parsed.summary.length > 0 ? parsed.summary : fallback.summary,
        themes:
          parsed.themes.length > 0
            ? countThemeHeadlines(parsed.themes, news)
            : fallback.themes,
        watch: parsed.watch.length > 0 ? parsed.watch : fallback.watch,
        headlineCount: news.length,
        sourceCount: sources.size,
        degradedReason: null,
      };
    }
    reason = "AI の応答から JSON を取り出せなかった";
  } catch (e) {
    reason = `AI 呼び出しに失敗: ${e instanceof Error ? e.name : "unknown"}`;
  }

  return ruleBasedBrief(news, ctx, reason);
}
