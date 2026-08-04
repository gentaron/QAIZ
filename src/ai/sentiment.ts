import type { Env, NewsItem, SentimentResult } from "../types";

/**
 * ニュースセンチメント分析。
 *
 * 1st choice: Cloudflare Workers AI (Meta Llama — 非Google、無料枠 10k Neurons/日)
 * fallback  : 内蔵レキシコン (AIバインディング未設定・無料枠超過でも動く)
 */

const LEXICON_POS = [
  "surge", "rally", "soar", "jump", "gain", "beat", "record", "boom",
  "bullish", "upgrade", "growth", "strong", "rise", "high", "profit",
  "上昇", "最高値", "好調", "増益", "回復",
];
const LEXICON_NEG = [
  "plunge", "crash", "fall", "drop", "slump", "miss", "fear", "recession",
  "bearish", "downgrade", "weak", "loss", "decline", "risk", "warning",
  "下落", "安値", "懸念", "減益", "暴落",
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

/**
 * Workers AI (Llama 3.1 8B) にヘッドライン束を渡し、
 * -1.0〜+1.0 のセンチメントスコアをJSONで返させる。
 */
export async function aiSentiment(
  env: Env,
  sectorName: string,
  headlines: string[]
): Promise<SentimentResult> {
  if (headlines.length === 0) {
    return { score: 0, label: "neutral", headlineCount: 0, method: "lexicon" };
  }
  try {
    const prompt = [
      `You are a financial sentiment analyst. Below are recent news headlines related to the "${sectorName}" sector.`,
      `Rate the overall near-term (1-4 week) outlook for this sector implied by these headlines.`,
      `Respond with ONLY a JSON object: {"score": <number from -1.0 (very bearish) to 1.0 (very bullish)>}`,
      ``,
      ...headlines.slice(0, 15).map((h, i) => `${i + 1}. ${h}`),
    ].join("\n");

    const result = (await env.AI.run(
      env.SENTIMENT_MODEL as keyof AiModels,
      {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 64,
        temperature: 0.1,
      } as never
    )) as { response?: string };

    const text = result.response ?? "";
    const m = text.match(/-?\d+(\.\d+)?/);
    if (!m) throw new Error("no score in AI response");
    const score = Math.max(-1, Math.min(1, parseFloat(m[0])));
    return {
      score: Math.round(score * 100) / 100,
      label: score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral",
      headlineCount: headlines.length,
      method: "workers-ai",
    };
  } catch {
    // 無料枠超過・モデルエラー時はレキシコンに自動フォールバック
    return lexiconSentiment(headlines);
  }
}
