import type { Env, NewsItem, SentimentResult } from "../types.ts";

/**
 * ニュースセンチメント。
 *
 * 第1候補: Cloudflare Workers AI (Llama 3.1 8B — 無料枠 10k Neurons/日)
 * 予備   : 内蔵レキシコン (AI が使えない・枠切れでも必ず値が出る)
 *
 * どちらで出したかを method に必ず残す。レキシコンは語彙の一致数を
 * 数えているだけなので、LLM の判定と同じ重みで扱ってはいけない。
 */

const LEXICON_POS = [
  "surge", "rally", "soar", "jump", "gain", "beat", "record high", "boom",
  "bullish", "upgrade", "growth", "strong", "rise", "profit", "outperform",
  "expansion", "recovery", "raises guidance",
  "上昇", "最高値", "好調", "増益", "回復", "上方修正", "続伸",
];
const LEXICON_NEG = [
  "plunge", "crash", "slump", "miss", "fear", "recession", "downgrade",
  "bearish", "weak", "loss", "decline", "warning", "cuts guidance", "layoff",
  "default", "bankruptcy", "selloff", "slowdown",
  "下落", "安値", "懸念", "減益", "暴落", "下方修正", "続落",
];

export function lexiconSentiment(headlines: string[]): SentimentResult {
  let pos = 0;
  let neg = 0;
  for (const h of headlines) {
    const lower = h.toLowerCase();
    for (const w of LEXICON_POS) if (lower.includes(w)) pos++;
    for (const w of LEXICON_NEG) if (lower.includes(w)) neg++;
  }
  const total = pos + neg;
  const score = total > 0 ? (pos - neg) / total : 0;
  return {
    score: Math.round(score * 100) / 100,
    label: score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral",
    headlineCount: headlines.length,
    method: "lexicon",
  };
}

/** キーワードに引っかかった見出しを集める */
export function matchHeadlines(news: NewsItem[], keywords: string[], limit = 12): string[] {
  const kw = keywords.map((k) => k.toLowerCase());
  const hits = news
    .filter((n) => {
      const t = n.title.toLowerCase();
      return kw.some((k) => t.includes(k));
    })
    .map((n) => n.title);
  return [...new Set(hits)].slice(0, limit);
}

export async function aiSentiment(
  env: Env,
  topic: string,
  headlines: string[]
): Promise<SentimentResult> {
  if (headlines.length === 0) {
    return { score: 0, label: "neutral", headlineCount: 0, method: "lexicon" };
  }
  try {
    const prompt = [
      `You are a sell-side equity analyst. Below are recent news headlines related to "${topic}".`,
      "Rate the near-term (1-4 week) outlook these headlines imply for that sector.",
      'Respond with ONLY a JSON object: {"score": <number from -1.0 (very bearish) to 1.0 (very bullish)>}',
      "",
      ...headlines.slice(0, 15).map((h, i) => `${i + 1}. ${h}`),
    ].join("\n");

    const result = (await env.AI.run(env.SENTIMENT_MODEL as keyof AiModels, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 48,
      temperature: 0.1,
    } as never)) as { response?: string };

    const m = (result.response ?? "").match(/-?\d+(\.\d+)?/);
    if (!m) throw new Error("no score in AI response");
    const score = Math.max(-1, Math.min(1, parseFloat(m[0])));
    return {
      score: Math.round(score * 100) / 100,
      label: score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral",
      headlineCount: headlines.length,
      method: "workers-ai",
    };
  } catch {
    return lexiconSentiment(headlines);
  }
}
