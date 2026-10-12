/**
 * TypeScript 側の「唯一の真実」を、Python から読める JSON に書き出す。
 *
 *   configs/qaiz_universe.json  … ユニバース定義 (src/config/universe.ts)
 *   configs/parity_vectors.json … クロスセクション統計のゴールデンベクタ
 *
 * 生成物はコミットする。CI (`test/shared-config.test.ts`) が
 * 「再生成しても差分が出ないこと」を検査するので、TS 側を編集して
 * この生成を忘れると落ちる。
 *
 * ## parity_vectors の役割
 *
 * ダッシュボードが「バリュースコア 72 点」と出している銘柄について、
 * 研究ラボが別の定義で 65 点を出したら、どちらの数字も信用できない。
 * Z スコア・ウィンザライズ・分位・パーセンタイル順位の定義が両言語で
 * 一致していることを、実際の数値で相互検証する。
 *
 * ここで生成した値が「正」。Python 側 (lab/tests/test_parity.py) は
 * この JSON に合わせる。TS 側を変えたら Python も追随する必要があり、
 * 追随しなければ CI が落ちる。
 *
 * 実行: npm run export:shared
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UNIVERSE } from "../src/config/universe.ts";
import { REGION_META, SECTOR_META } from "../src/config/sectors.ts";
import { VERSION } from "../src/config/index.ts";
import {
  mad,
  median,
  percentileRanks,
  quantile,
  weightedMean,
  winsorize,
  zToScore,
  zscores,
} from "../src/analytics/stats.ts";
import type { Num } from "../src/analytics/stats.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/* ユニバース                                                          */
/* ------------------------------------------------------------------ */

export function buildUniverseExport(): unknown {
  return {
    _generated_by: "npm run export:shared (scripts/export-shared.ts)",
    _note: "手で編集しない。src/config/universe.ts を編集して再生成する。",
    version: VERSION,
    size: UNIVERSE.length,
    regions: Object.fromEntries(
      Object.entries(REGION_META).map(([id, m]) => [id, { nameJa: m.nameJa, benchmark: m.benchmark }])
    ),
    sectors: Object.fromEntries(
      Object.entries(SECTOR_META).map(([id, m]) => [id, { nameJa: m.nameJa, nameEn: m.nameEn }])
    ),
    instruments: UNIVERSE.map((i) => ({
      symbol: i.symbol,
      name: i.name,
      nameJa: i.nameJa,
      region: i.region,
      sector: i.sector,
      role: i.role,
      assetClass: i.assetClass,
      currency: i.currency,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* パリティベクタ                                                      */
/* ------------------------------------------------------------------ */

/** 決定論的な擬似乱数 (test/helpers.ts と同じ実装)。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 実務で実際に起きる形の入力を並べる。「綺麗な配列」だけでは差が出ない。 */
function sampleInputs(): { id: string; values: Num[]; why: string }[] {
  const r = rng(20260910);
  const normal: number[] = [];
  for (let i = 0; i < 40; i++) {
    // Box-Muller
    const u1 = Math.max(1e-12, r());
    const u2 = r();
    normal.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * 12 + 20);
  }

  return [
    {
      id: "plain",
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      why: "基本形。分位の補間と順位付けの一致を見る",
    },
    {
      id: "with_nulls",
      values: [1, null, 3, undefined, 5, NaN, 7, Infinity, 9, 10],
      why: "欠損・非有限値の扱い。null が 0 に潰れていないか",
    },
    {
      id: "extreme_valuation",
      values: [8, 11, 12, 13, 14, 15, 16, 18, 22, 4000],
      why: "PER 4000倍のような外れ値。ウィンザライズが効いているか",
    },
    {
      id: "ties",
      values: [5, 5, 5, 5, 1, 9, 9, 3, 3, 3],
      why: "同値。パーセンタイル順位で平均順位が配られているか",
    },
    {
      id: "negative",
      values: [-30, -12, -5, -1, 0, 2, 8, 15, 40, 120],
      why: "負値を含む (成長率・リターン)。符号の扱い",
    },
    {
      id: "two_valid",
      values: [null, 3.5, null, 7.25, null],
      why: "有効値 2 個。3 未満なので z は全部 null になるべき",
    },
    {
      id: "constant",
      values: [4, 4, 4, 4, 4, 4],
      why: "散らばりゼロ。ゼロ除算せずに null になるべき",
    },
    { id: "normalish", values: normal, why: "正規分布に近い 40 点。頑健版と通常版の差" },
  ];
}

export function buildParityVectors(): unknown {
  const cases = sampleInputs().map((c) => {
    const finite = c.values.filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v)
    );
    return {
      id: c.id,
      why: c.why,
      input: c.values.map((v) =>
        typeof v === "number" && Number.isFinite(v) ? v : null
      ),
      expected: {
        median: median(finite),
        mad: mad(finite),
        q25: quantile(finite, 0.25),
        q75: quantile(finite, 0.75),
        winsorize_05: winsorize(finite, 0.05),
        zscores_plain: zscores(c.values),
        zscores_winsorized: zscores(c.values, { winsorizeAt: 0.05 }),
        zscores_robust: zscores(c.values, { winsorizeAt: 0.05, robust: true }),
        percentile_ranks: percentileRanks(c.values),
        z_to_score: zscores(c.values, { winsorizeAt: 0.05 }).map(zToScore),
      },
    };
  });

  const weighted = [
    { value: 1.5, weight: 0.25 },
    { value: null as number | null, weight: 0.25 },
    { value: -0.5, weight: 0.5 },
  ];
  const wm = weightedMean(weighted);

  return {
    _generated_by: "npm run export:shared (scripts/export-shared.ts)",
    _note:
      "TypeScript 側 (src/analytics/stats.ts) の出力が『正』。" +
      "Python 側 (lab/qaiz_lab/xsection.py) はこれに一致しなければならない。" +
      "片方だけ変更すると CI が落ちる。",
    _tolerance: 1e-9,
    source: "src/analytics/stats.ts",
    cases,
    weighted_mean: {
      input: weighted.map((w) => ({ value: w.value, weight: w.weight })),
      expected: { value: wm.value, usedWeight: wm.usedWeight },
      why: "値が null の要素を無視してウェイトを再正規化しているか",
    },
  };
}

/* ------------------------------------------------------------------ */

/** JSON をキー順を保ったまま安定した文字列にする (差分検査のため)。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (Number.isNaN(v) ? null : v), 2) + "\n";
}

function main(): void {
  const targets: [string, unknown][] = [
    ["configs/qaiz_universe.json", buildUniverseExport()],
    ["configs/parity_vectors.json", buildParityVectors()],
  ];
  for (const [rel, data] of targets) {
    writeFileSync(join(ROOT, rel), stableJson(data), "utf-8");
    console.log(`wrote ${rel}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
