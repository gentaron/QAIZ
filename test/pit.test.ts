import assert from "node:assert/strict";
import test from "node:test";

import {
  PIT_RETENTION_DAYS,
  PIT_SCHEMA_VERSION,
  jstDate,
  loadPitRecords,
  pitKey,
  pitStatus,
  prunePit,
  recordPitObservations,
  toNdjson,
} from "../src/pit.ts";
import type { PitRecord } from "../src/pit.ts";
import type { Consensus, Env, Fundamentals } from "../src/types.ts";

/**
 * PIT ジャーナルのテスト。
 *
 * ここは研究ラボが available_at として使う値を作る場所なので、
 * observed_at が実際の観測時刻からずれると、研究側の未来情報混入検査を
 * すり抜けたまま結果が汚染される。Worker 側で止める必要がある。
 */

/** Durable Object の代わりにメモリ上のストアを持つ最小の Env スタブ。 */
function fakeEnv(): Env & { _store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const stub = {
    fetch: async (_url: string, init?: { body?: string }) => {
      const req = JSON.parse(init?.body ?? "{}") as {
        op: string;
        key?: string;
        keys?: string[];
        prefix?: string;
        value?: unknown;
      };
      let payload: unknown;
      switch (req.op) {
        case "get":
          payload = { value: store.get(req.key!) ?? null };
          break;
        case "put":
          store.set(req.key!, req.value);
          payload = { ok: true };
          break;
        case "delete":
          store.delete(req.key!);
          payload = { ok: true };
          break;
        case "list": {
          const values: Record<string, unknown> = {};
          for (const [k, v] of store) if (k.startsWith(req.prefix ?? "")) values[k] = v;
          payload = { values };
          break;
        }
        case "mget": {
          const values: Record<string, unknown> = {};
          for (const k of req.keys ?? []) if (store.has(k)) values[k] = store.get(k);
          payload = { values };
          break;
        }
        default:
          payload = { error: "unknown op" };
      }
      return { json: async () => payload } as unknown as Response;
    },
  };
  const env = {
    STORE: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub,
    },
    _store: store,
  } as unknown as Env & { _store: Map<string, unknown> };
  return env;
}

function fundamentals(overrides: Partial<Fundamentals> = {}): Fundamentals {
  return {
    symbol: "7203.T", asOf: "2026-09-10", source: "yahoo", currency: "JPY",
    marketCap: 4e13, enterpriseValue: null, sharesOutstanding: 1.3e10, floatShares: null,
    trailingPE: 12.4, forwardPE: 11.2, pegRatio: null, priceToBook: 1.1, priceToSales: null,
    evToEbitda: null, evToSales: null, evToFcf: null, earningsYield: null, fcfYield: null,
    dividendYield: 0.025, payoutRatio: null, buybackYield: null,
    returnOnEquity: 0.14, returnOnAssets: null, returnOnInvestedCapital: null,
    grossMargin: null, operatingMargin: 0.10, profitMargin: null, ebitdaMargin: null,
    debtToEquity: null, netDebtToEbitda: null, currentRatio: null, quickRatio: null,
    interestCoverage: null, totalCash: null, totalDebt: null,
    revenueGrowth: 0.06, earningsGrowth: null, earningsQuarterlyGrowth: null, revenue3yCagr: null,
    beta: null, shortPercentOfFloat: 0.012, heldPercentInstitutions: null, heldPercentInsiders: null,
    trailingEps: null, forwardEps: null, bookValuePerShare: null, revenuePerShare: null,
    revenueValue: null, ebitdaValue: null, ebitValue: null, freeCashflowValue: null,
    operatingCashflowValue: null, totalEquityValue: null, interestExpenseValue: null,
    fieldSources: {},
    ...overrides,
  };
}

function consensus(): Consensus {
  return {
    symbol: "7203.T", asOf: "2026-09-10", source: "yahoo",
    recommendationMean: 2.1, recommendationKey: "buy", analystCount: 18,
    targetMean: 3800, targetHigh: 4500, targetLow: 3000, targetMedian: 3750,
    upsideToTarget: 0.12, targetDispersion: 0.39, trend: [], ratingMomentum: 0.2,
    epsRevision: null,
  };
}

const T0 = Date.parse("2026-09-10T01:23:45Z"); // JST 10:23

test("jstDate: UTC ではなく JST の暦日を返す", () => {
  // UTC では 9/9 だが JST では 9/10
  assert.equal(jstDate(Date.parse("2026-09-09T23:00:00Z")), "2026-09-10");
  assert.equal(jstDate(Date.parse("2026-09-10T00:30:00Z")), "2026-09-10");
});

test("recordPitObservations: observed_at が実際の観測時刻になる", async () => {
  const env = fakeEnv();
  const written = await recordPitObservations(
    env,
    [{ symbol: "7203.T", fundamentals: fundamentals(), consensus: consensus() }],
    T0
  );
  assert.equal(written, 1);

  const rec = env._store.get(pitKey("2026-09-10", "7203.T")) as PitRecord;
  assert.equal(rec.observed_at, new Date(T0).toISOString());
  assert.equal(rec.schema_version, PIT_SCHEMA_VERSION);
  assert.equal(rec.date, "2026-09-10");
  assert.equal(rec.fundamentals?.forwardPE, 11.2);
  assert.equal(rec.consensus?.targetMean, 3800);
});

test("recordPitObservations: 同じ日の 2 回目は上書きしない (先勝ち)", async () => {
  const env = fakeEnv();
  await recordPitObservations(
    env, [{ symbol: "7203.T", fundamentals: fundamentals({ forwardPE: 11.2 }), consensus: null }], T0
  );
  const later = T0 + 3 * 3600 * 1000;
  const written = await recordPitObservations(
    env, [{ symbol: "7203.T", fundamentals: fundamentals({ forwardPE: 99.9 }), consensus: null }], later
  );

  assert.equal(written, 0, "2 回目が書き込まれている");
  const rec = env._store.get(pitKey("2026-09-10", "7203.T")) as PitRecord;
  assert.equal(rec.observed_at, new Date(T0).toISOString(),
    "observed_at が後ろにずれている。「もっと早く知っていた」事実が消える");
  assert.equal(rec.fundamentals?.forwardPE, 11.2);
});

test("recordPitObservations: 価格から再計算できる値は保存しない", async () => {
  const env = fakeEnv();
  await recordPitObservations(
    env, [{ symbol: "7203.T", fundamentals: fundamentals(), consensus: consensus() }], T0
  );
  const rec = env._store.get(pitKey("2026-09-10", "7203.T")) as PitRecord;
  const keys = Object.keys(rec.fundamentals ?? {});

  // ベータ・EPS などは価格や公開情報から後で再構成できる/意味が薄いので載せない
  for (const excluded of ["beta", "trailingEps", "fieldSources", "asOf"]) {
    assert.ok(!keys.includes(excluded), `再取得可能な ${excluded} が保存されている`);
  }
  // 再取得不能なものは載っている
  for (const included of ["forwardPE", "returnOnEquity", "shortPercentOfFloat"]) {
    assert.ok(keys.includes(included), `再取得不能な ${included} が保存されていない`);
  }
});

test("recordPitObservations: 欠損は null として残す (キーごと落とさない)", async () => {
  const env = fakeEnv();
  await recordPitObservations(
    env,
    [{ symbol: "X", fundamentals: fundamentals({ trailingPE: null }), consensus: null }],
    T0
  );
  const rec = env._store.get(pitKey("2026-09-10", "X")) as PitRecord;
  assert.ok("trailingPE" in (rec.fundamentals ?? {}));
  assert.equal(rec.fundamentals?.trailingPE, null);
});

test("recordPitObservations: 中身が空なら記録しない", async () => {
  const env = fakeEnv();
  const written = await recordPitObservations(
    env, [{ symbol: "ETF", fundamentals: null, consensus: null }], T0
  );
  assert.equal(written, 0);
  assert.equal(env._store.size, 0);
});

test("loadPitRecords: 期間で絞り込め、日付順に並ぶ", async () => {
  const env = fakeEnv();
  const day = 86400_000;
  for (let i = 0; i < 5; i++) {
    await recordPitObservations(
      env, [{ symbol: "A", fundamentals: fundamentals(), consensus: null }], T0 + i * day
    );
  }
  const all = await loadPitRecords(env);
  assert.equal(all.length, 5);
  assert.deepEqual([...all].map((r) => r.date).sort(), all.map((r) => r.date));

  const slice = await loadPitRecords(env, { from: "2026-09-12", to: "2026-09-13" });
  assert.deepEqual(slice.map((r) => r.date), ["2026-09-12", "2026-09-13"]);
});

test("pitStatus: 保持期限が近づいたら警告する", async () => {
  const env = fakeEnv();
  const old = T0 - (PIT_RETENTION_DAYS - 10) * 86400_000;
  await recordPitObservations(
    env, [{ symbol: "A", fundamentals: fundamentals(), consensus: null }], old
  );

  const status = await pitStatus(env, T0);
  assert.equal(status.records, 1);
  assert.ok(status.daysUntilPrune !== null && status.daysUntilPrune <= 10);
  assert.ok(status.warning?.includes("pit-sync"),
    "退避方法が警告に書かれていない。消えた観測は再構成できない");
});

test("pitStatus: 蓄積が浅いうちは警告しない", async () => {
  const env = fakeEnv();
  await recordPitObservations(
    env, [{ symbol: "A", fundamentals: fundamentals(), consensus: null }], T0
  );
  const status = await pitStatus(env, T0);
  assert.equal(status.warning, null);
  assert.equal(status.symbols, 1);
  assert.equal(status.days, 1);
});

test("prunePit: 保持期限を超えた日付だけ削除する", async () => {
  const env = fakeEnv();
  const day = 86400_000;
  const old = T0 - (PIT_RETENTION_DAYS + 5) * day;
  await recordPitObservations(env, [{ symbol: "A", fundamentals: fundamentals(), consensus: null }], old);
  await recordPitObservations(env, [{ symbol: "A", fundamentals: fundamentals(), consensus: null }], T0);

  const before = (await loadPitRecords(env)).length;
  assert.equal(before, 2);

  const { deleted } = await prunePit(env, T0);
  assert.equal(deleted, 1);
  const after = await loadPitRecords(env);
  assert.equal(after.length, 1);
  assert.equal(after[0].date, "2026-09-10");
});

test("prunePit: 1 回の削除件数に上限がある (cron が途中で切れないように)", async () => {
  const env = fakeEnv();
  const day = 86400_000;
  for (let i = 0; i < 12; i++) {
    await recordPitObservations(
      env,
      [{ symbol: `S${i}`, fundamentals: fundamentals(), consensus: null }],
      T0 - (PIT_RETENTION_DAYS + 10 + i) * day
    );
  }
  const { deleted } = await prunePit(env, T0, 5);
  assert.equal(deleted, 5);
  assert.equal((await loadPitRecords(env)).length, 7);
});

test("toNdjson: 1 行 1 レコードで、行ごとにパースできる", async () => {
  const env = fakeEnv();
  await recordPitObservations(env, [
    { symbol: "A", fundamentals: fundamentals(), consensus: null },
    { symbol: "B", fundamentals: fundamentals(), consensus: consensus() },
  ], T0);

  const text = toNdjson(await loadPitRecords(env));
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const rec = JSON.parse(line) as PitRecord;
    assert.ok(rec.symbol && rec.observed_at && rec.date);
  }
});

test("toNdjson: 空でも壊れた JSON を出さない", () => {
  assert.equal(toNdjson([]), "");
});
