import { httpGet } from "./http.ts";
import { readZipText } from "./zip.ts";

/**
 * Ken French Data Library — Fama-French ファクターの日次リターン。
 *
 * これを入れる目的は「QAIZ のスコアに新しい情報があるか」を測ることに尽きる。
 * 市場・規模・バリュー・収益性・投資・モメンタムという既知のファクターで
 * 説明できてしまうリターンは、こちらが何か発見したわけではない。
 * **自分の主張を否定できる材料**を先に置くための対照群。
 *
 * 公式・無料・キー不要 (ダートマス大の公開ページ)。ZIP 配布なので
 * datasources/zip.ts で展開する。
 *
 * 注意: 元データの単位は **パーセント** (-0.67 は -0.67%)。
 * 小数に直して保持する。ここを間違えると回帰の係数が 100 倍ずれる。
 */

const BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";
const FIVE_FACTOR = `${BASE}/F-F_Research_Data_5_Factors_2x3_daily_CSV.zip`;
const MOMENTUM = `${BASE}/F-F_Momentum_Factor_daily_CSV.zip`;

/** 保持する営業日数。3 年あれば 1 年窓の回帰を複数期間で回せる */
export const KEEP_DAYS = 800;

export interface FactorDay {
  /** YYYYMMDD */
  d: number;
  /** 市場超過リターン (小数) */
  mktRf: number;
  /** 小型 − 大型 */
  smb: number;
  /** バリュー − グロース */
  hml: number;
  /** 高収益性 − 低収益性 */
  rmw: number;
  /** 保守的投資 − 積極的投資 */
  cma: number;
  /** 無リスク金利 (日次) */
  rf: number;
  /** モメンタム (別ファイル。欠ける日がある) */
  mom: number | null;
}

export interface FactorSeries {
  source: string;
  fetchedAt: string;
  from: number;
  to: number;
  days: FactorDay[];
  /** 取得時の注意事項 (欠損など) */
  notes: string[];
}

/**
 * Ken French の CSV をパースする。
 *
 * ファイル先頭に説明文、末尾に別集計 (年次など) が付くことがあるので、
 * 「8 桁の日付で始まる行」だけを拾う。ヘッダ行の位置に依存した
 * 決め打ちのスキップは、フォーマットが少し変わるだけで壊れる。
 */
export function parseFrenchCsv(
  text: string,
  columns: number
): { d: number; v: number[] }[] {
  const out: { d: number; v: number[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{8})\s*,(.*)$/);
    if (!m) continue;
    const d = Number(m[1]);
    const parts = m[2].split(",").map((x) => x.trim());
    if (parts.length < columns) continue;
    const v: number[] = [];
    let ok = true;
    for (let i = 0; i < columns; i++) {
      const n = Number(parts[i]);
      // -99.99 / -999 は Ken French の欠損コード
      if (!Number.isFinite(n) || n <= -99) {
        ok = false;
        break;
      }
      v.push(n / 100); // パーセント → 小数
    }
    if (ok) out.push({ d, v });
  }
  return out;
}

async function fetchZipCsv(url: string): Promise<string | null> {
  const res = await httpGet(url, { cacheTtl: 86400, timeoutMs: 20000 });
  if (!res || !res.ok) return null;
  const buf = await res.arrayBuffer();
  const { text } = await readZipText(buf, (es) => es.find((e) => /\.csv$/i.test(e.name)) ?? es[0]);
  return text;
}

/**
 * 5 ファクター + モメンタムを取得して結合する。
 * 消費するサブリクエストは 2。週 1 回で十分なので呼び出し側でキャッシュする。
 */
export async function fetchFrenchFactors(): Promise<FactorSeries | null> {
  const notes: string[] = [];

  const fiveText = await fetchZipCsv(FIVE_FACTOR);
  if (!fiveText) return null;
  const five = parseFrenchCsv(fiveText, 6); // Mkt-RF, SMB, HML, RMW, CMA, RF
  if (five.length < 100) return null;

  let momMap = new Map<number, number>();
  try {
    const momText = await fetchZipCsv(MOMENTUM);
    if (momText) {
      for (const r of parseFrenchCsv(momText, 1)) momMap.set(r.d, r.v[0]);
    } else {
      notes.push("モメンタム係数の取得に失敗。5 ファクターのみで回帰する");
    }
  } catch {
    notes.push("モメンタム係数のパースに失敗。5 ファクターのみで回帰する");
  }

  const tail = five.slice(-KEEP_DAYS);
  const days: FactorDay[] = tail.map((r) => ({
    d: r.d,
    mktRf: r.v[0],
    smb: r.v[1],
    hml: r.v[2],
    rmw: r.v[3],
    cma: r.v[4],
    rf: r.v[5],
    mom: momMap.get(r.d) ?? null,
  }));

  const missingMom = days.filter((x) => x.mom === null).length;
  if (missingMom > 0) {
    notes.push(`モメンタムが ${missingMom}/${days.length} 日ぶん欠損 (5 ファクターの更新が先行することがある)`);
  }

  return {
    source: "Ken French Data Library (Dartmouth)",
    fetchedAt: new Date().toISOString(),
    from: days[0]?.d ?? 0,
    to: days[days.length - 1]?.d ?? 0,
    days,
    notes,
  };
}

/** YYYYMMDD → unix 日 (UTC 00:00 基準)。価格系列との突き合わせに使う */
export function frenchDateToDayKey(d: number): number {
  const y = Math.floor(d / 10000);
  const m = Math.floor((d % 10000) / 100);
  const day = d % 100;
  return Math.floor(Date.UTC(y, m - 1, day) / 1000 / 86400);
}
