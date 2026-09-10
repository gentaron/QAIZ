import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildParityVectors,
  buildUniverseExport,
  stableJson,
} from "../scripts/export-shared.ts";

/**
 * configs/ のドリフト検査。
 *
 * `configs/qaiz_universe.json` と `configs/parity_vectors.json` は
 * TypeScript 側から生成される。ユニバースや統計関数を編集して
 * 再生成を忘れると、Python 側が古い定義を読み続ける。
 *
 * ドリフトは静かに起きる。ダッシュボードには新しい銘柄が出ているのに
 * 研究では出てこない、Z スコアの定義が片方だけ変わっている — どちらも
 * 実行時エラーにならないので、CI で機械的に検出する必要がある。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function committed(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

test("configs/qaiz_universe.json が最新である", () => {
  assert.equal(
    committed("configs/qaiz_universe.json"),
    stableJson(buildUniverseExport()),
    "ユニバースの JSON が古い。`npm run export:shared` を実行して commit すること"
  );
});

test("configs/parity_vectors.json が最新である", () => {
  assert.equal(
    committed("configs/parity_vectors.json"),
    stableJson(buildParityVectors()),
    "パリティベクタが古い。src/analytics/stats.ts を変更したら " +
      "`npm run export:shared` を実行し、Python 側 (lab/qaiz_lab/xsection.py) も追随させること"
  );
});

test("パリティベクタが実務で起きる入力を含んでいる", () => {
  const v = JSON.parse(committed("configs/parity_vectors.json")) as {
    cases: { id: string; input: (number | null)[] }[];
  };
  const ids = new Set(v.cases.map((c) => c.id));

  // 「綺麗な配列」だけでは言語差が出ない。差が出る形を必ず含める
  for (const required of ["with_nulls", "extreme_valuation", "ties", "constant", "two_valid"]) {
    assert.ok(ids.has(required), `パリティ検証に ${required} のケースが無い`);
  }

  const withNulls = v.cases.find((c) => c.id === "with_nulls")!;
  assert.ok(
    withNulls.input.some((x) => x === null),
    "欠損を含むケースなのに null が 1 つも無い"
  );
});

test("共有 config が JSON として読める (Python 側が読む形式)", () => {
  for (const rel of [
    "configs/universe.jp.json",
    "configs/costs.jp.json",
    "configs/research/r001_margin.json",
    "configs/qaiz_universe.json",
    "configs/parity_vectors.json",
  ]) {
    assert.doesNotThrow(() => JSON.parse(committed(rel)), `${rel} が JSON として壊れている`);
  }
});

test("R001 の設定が事前登録として必要な項目を持つ", () => {
  const cfg = JSON.parse(committed("configs/research/r001_margin.json")) as Record<string, unknown>;
  for (const key of [
    "experiment_id", "hypothesis", "data", "availability", "signals",
    "targets", "universe", "evaluation", "periods", "cost_assumption",
    "multiple_testing", "known_blockers",
  ]) {
    assert.ok(key in cfg, `事前登録に ${key} が無い`);
  }

  const hypothesis = cfg.hypothesis as Record<string, unknown>;
  assert.equal(
    hypothesis.direction,
    "UNDECIDED",
    "仮説の符号が事前に決まっている。どちらに出ても後付けの説明ができてしまう"
  );

  const availability = cfg.availability as Record<string, unknown>;
  assert.equal(
    availability.verification,
    "UNVERIFIED",
    "公表規則を一次情報で確認していないのに UNVERIFIED が外れている"
  );

  const mt = cfg.multiple_testing as Record<string, number>;
  assert.equal(
    mt.planned_tests,
    mt.signals * mt.lookbacks * mt.horizons * mt.target_variants * mt.neutralizations,
    "planned_tests が組み合わせ数と一致していない (多重検定の割り引きが甘くなる)"
  );
});

test("コスト設定に『これは仮定である』という但し書きがある", () => {
  const raw = committed("configs/costs.jp.json");
  assert.ok(raw.includes("仮定"), "コスト前提が実測かのように書かれている");

  const cfg = JSON.parse(raw) as { stress_multipliers: { commission: number[] } };
  assert.ok(
    cfg.stress_multipliers.commission.includes(2),
    "コスト 2 倍のストレス設定が無い"
  );
});
