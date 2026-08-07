import type { Bar, InstrumentRecord, Relation, RelationKind } from "../types.ts";
import { SECTOR_META } from "../config/sectors.ts";
import { themeNeighbors } from "../config/themes.ts";
import { alignByDate } from "./returns.ts";
import { correlation, isNum, round } from "./stats.ts";

/**
 * 関連銘柄の算出。
 *
 * 「関連銘柄」を一種類で済ませないのが要点。同じセクターというだけの関係と、
 * 実際に値動きが揃っている関係と、供給網で繋がっている関係はまったく別物で、
 * 使い道も違う。
 *
 *   sector-peer  … 比較対象。割高/割安を判断する物差し
 *   co-moving    … 一緒に持つと分散にならない。重複ポジションの検出
 *   diversifier  … 逆に動く。ヘッジや分散の候補
 *   factor-twin  … ファクター構成が似ている。代替候補
 *   theme        … 供給網・テーマで繋がる。波及の順序が読める
 *   macro-driver … 共通のマクロ要因。何を見張ればいいかが分かる
 *
 * 相関だけで「関連」と言うと、たまたま同じ時期に上がっただけの銘柄が
 * 出てくる。逆にセクター分類だけだと、実際には連動していない組み合わせを
 * 「関連」と呼んでしまう。両方を別のラベルで出して、使い分けを利用者に委ねる。
 */

const KIND_LABEL: Record<RelationKind, string> = {
  "sector-peer": "同業",
  "co-moving": "連動",
  diversifier: "分散",
  "factor-twin": "similar",
  theme: "テーマ",
  "macro-driver": "マクロ要因",
};

export interface RelatedInput {
  symbol: string;
  record: InstrumentRecord;
  bars: Bar[];
}

/** 相関計算の窓 (営業日) */
const CORR_WINDOW = 126;

function pairCorrelation(a: Bar[], b: Bar[]): number | null {
  const al = alignByDate(a, b);
  if (al.days < 40) return null;
  return correlation(al.a.slice(-CORR_WINDOW), al.b.slice(-CORR_WINDOW));
}

/**
 * ファクター空間での距離。5 ファクターのスコア (0-100) を使い、
 * 欠けているファクターは距離計算から除いて次元数で正規化する。
 */
function factorDistance(a: InstrumentRecord, b: InstrumentRecord): number | null {
  const fa = a.factors;
  const fb = b.factors;
  if (!fa || !fb) return null;
  const keys = ["value", "quality", "momentum", "growth", "lowVol"] as const;
  let acc = 0;
  let n = 0;
  for (const k of keys) {
    const x = fa[k];
    const y = fb[k];
    if (isNum(x) && isNum(y)) {
      acc += ((x - y) / 100) ** 2;
      n++;
    }
  }
  if (n < 3) return null;
  return Math.sqrt(acc / n);
}

/** マクロ要因の対応表。何を見張ればいいかを言語化するために使う */
const MACRO_DRIVERS: { symbol: string; nameJa: string; plain: string }[] = [
  { symbol: "^TNX", nameJa: "米10年金利", plain: "金利が上がると割高な成長株や不動産・公益に逆風、銀行に追い風。" },
  { symbol: "DX-Y.NYB", nameJa: "ドル指数", plain: "ドル高は新興国と商品に逆風。米国外で稼ぐ企業の円換算利益にも効く。" },
  { symbol: "CL=F", nameJa: "WTI原油", plain: "エネルギーには追い風、燃料を使う輸送・消費関連には逆風。" },
  { symbol: "GC=F", nameJa: "金", plain: "実質金利が下がると上がりやすい。株の退避先。" },
  { symbol: "^VIX", nameJa: "VIX", plain: "市場の警戒度。上がるとハイベータ銘柄から先に売られる。" },
  { symbol: "USDJPY=X", nameJa: "ドル円", plain: "円安は日本の輸出企業の円換算利益を押し上げる。" },
];

export interface RelatedOptions {
  /** 各カテゴリの最大件数 */
  perKind?: number;
  /** 連動とみなす相関の下限 */
  coMovingAt?: number;
  /** 分散とみなす相関の上限 */
  diversifierAt?: number;
}

/**
 * 1 銘柄について関連銘柄を算出する。
 *
 * `universe` には比較対象のレコードと価格系列を渡す。全銘柄を渡す必要はなく、
 * 同一セクター + セクター代表 + マクロ程度で十分 (呼び出し側で絞る)。
 */
export function computeRelated(
  target: RelatedInput,
  universe: RelatedInput[],
  opts: RelatedOptions = {}
): Relation[] {
  const perKind = opts.perKind ?? 4;
  const coAt = opts.coMovingAt ?? 0.6;
  const divAt = opts.diversifierAt ?? 0.15;

  const out: Relation[] = [];
  const others = universe.filter((u) => u.symbol !== target.symbol);
  const tSector = target.record.instrument.sector;
  const sectorJa = SECTOR_META[tSector]?.nameJa ?? tSector;

  // 相関は 1 度だけ計算して使い回す (連動・分散・同業の説明すべてに使う)
  const corr = new Map<string, number>();
  for (const o of others) {
    const c = pairCorrelation(target.bars, o.bars);
    if (isNum(c)) corr.set(o.symbol, c);
  }

  const push = (
    o: RelatedInput,
    kind: RelationKind,
    strength: number,
    evidence: string,
    plain: string
  ) => {
    out.push({
      symbol: o.symbol,
      nameJa: o.record.instrument.nameJa,
      region: o.record.instrument.region,
      sector: o.record.instrument.sector,
      kind,
      kindLabel: KIND_LABEL[kind],
      strength: round(Math.max(0, Math.min(1, strength)), 3)!,
      evidence,
      plain,
    });
  };

  /* ---------- 同業 (比較の物差し) ---------- */
  const peers = others
    .filter(
      (o) =>
        o.record.instrument.sector === tSector &&
        o.record.instrument.role === target.record.instrument.role
    )
    // 時価総額が近い順。規模が違いすぎる相手は比較対象にならない
    .map((o) => {
      const mc = o.record.fundamentals?.marketCap ?? null;
      const tc = target.record.fundamentals?.marketCap ?? null;
      const gap = isNum(mc) && isNum(tc) && mc > 0 && tc > 0 ? Math.abs(Math.log(mc / tc)) : 99;
      return { o, gap };
    })
    .sort((a, b) => a.gap - b.gap)
    .slice(0, perKind);

  for (const { o, gap } of peers) {
    const c = corr.get(o.symbol);
    const pe = o.record.fundamentals?.forwardPE ?? null;
    const tpe = target.record.fundamentals?.forwardPE ?? null;
    const cmp =
      isNum(pe) && isNum(tpe)
        ? `予想PER ${tpe.toFixed(1)}倍 vs ${pe.toFixed(1)}倍`
        : "バリュエーション比較はデータ未取得";
    push(
      o,
      "sector-peer",
      gap < 99 ? Math.max(0.3, 1 - gap / 3) : 0.4,
      `${cmp}${isNum(c) ? ` / 相関 ${c.toFixed(2)}` : ""}`,
      `同じ「${sectorJa}」の銘柄。割高か割安かは、市場全体ではなくこういう同業と比べて初めて判断できる。`
    );
  }

  /* ---------- 連動 (分散にならない組み合わせ) ---------- */
  const coMoving = [...corr.entries()]
    .filter(([, c]) => c >= coAt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, perKind);
  for (const [sym, c] of coMoving) {
    const o = others.find((x) => x.symbol === sym)!;
    push(
      o,
      "co-moving",
      c,
      `直近${CORR_WINDOW}営業日の相関 ${c.toFixed(2)}`,
      `値動きがかなり揃っている。両方持っても分散にはならず、実質的に同じ賭けを2倍しているのに近い。`
    );
  }

  /* ---------- 分散 (逆または無関係に動く) ---------- */
  const diversifiers = [...corr.entries()]
    .filter(([, c]) => c <= divAt)
    .sort((a, b) => a[1] - b[1])
    .slice(0, perKind);
  for (const [sym, c] of diversifiers) {
    const o = others.find((x) => x.symbol === sym)!;
    push(
      o,
      "diversifier",
      Math.min(1, (divAt - c + 0.2) / 1.2),
      `相関 ${c.toFixed(2)}`,
      c < 0
        ? `逆方向に動く傾向。片方が下げるときにもう片方が支えるので、組み合わせると値動きが穏やかになる。`
        : `ほとんど連動しない。分散の効果が出やすい組み合わせ。`
    );
  }

  /* ---------- ファクター双子 (代替候補) ---------- */
  const twins = others
    .map((o) => ({ o, d: factorDistance(target.record, o.record) }))
    .filter((x): x is { o: RelatedInput; d: number } => x.d !== null)
    .sort((a, b) => a.d - b.d)
    .slice(0, perKind);
  for (const { o, d } of twins) {
    const f = o.record.factors!;
    push(
      o,
      "factor-twin",
      Math.max(0, 1 - d * 2.5),
      `ファクター距離 ${d.toFixed(3)} (割安${f.value?.toFixed(0) ?? "—"} / 質${f.quality?.toFixed(0) ?? "—"} / 勢い${f.momentum?.toFixed(0) ?? "—"})`,
      `割安さ・質・勢いの組み合わせが似ている銘柄。同じ狙いで買える代替候補として比較する価値がある。`
    );
  }

  /* ---------- テーマ・供給網 ---------- */
  const byKnown = new Map(universe.map((u) => [u.symbol, u]));
  for (const t of themeNeighbors(target.symbol)) {
    for (const stage of t.otherStages) {
      for (const sym of stage.symbols) {
        const o = byKnown.get(sym);
        if (!o || sym === target.symbol) continue;
        if (out.some((r) => r.symbol === sym && r.kind === "theme")) continue;
        push(
          o,
          "theme",
          0.75,
          `${t.theme.nameJa} / ${stage.stage}`,
          `${stage.role}。${t.theme.plain.slice(0, 60)}…`
        );
      }
    }
    for (const sym of t.sameStage) {
      const o = byKnown.get(sym);
      if (!o) continue;
      if (out.some((r) => r.symbol === sym && r.kind === "theme")) continue;
      push(
        o,
        "theme",
        0.85,
        `${t.theme.nameJa} / 同じ段`,
        `テーマの中で同じ役割を担う銘柄。需要が来れば同じタイミングで効く。`
      );
    }
  }

  /* ---------- マクロ要因 ---------- */
  for (const m of MACRO_DRIVERS) {
    const o = byKnown.get(m.symbol);
    if (!o) continue;
    const c = corr.get(m.symbol);
    if (!isNum(c) || Math.abs(c) < 0.25) continue;
    push(
      o,
      "macro-driver",
      Math.min(1, Math.abs(c)),
      `相関 ${c.toFixed(2)} (${c > 0 ? "同方向" : "逆方向"})`,
      `${m.plain} この銘柄は${m.nameJa}と${c > 0 ? "同じ" : "反対"}方向に動く傾向があるので、${m.nameJa}のニュースは直接の材料になる。`
    );
  }

  // 種別ごとの上限を守りつつ、強い順に並べる
  const capped: Relation[] = [];
  const count = new Map<RelationKind, number>();
  for (const r of out.sort((a, b) => b.strength - a.strength)) {
    const n = count.get(r.kind) ?? 0;
    if (n >= perKind) continue;
    count.set(r.kind, n + 1);
    capped.push(r);
  }
  return capped;
}

export { KIND_LABEL };
