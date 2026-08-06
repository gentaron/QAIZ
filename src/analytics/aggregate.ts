import type {
  InstrumentRecord,
  SectorAggregate,
  SentimentResult,
} from "../types.ts";
import { SECTOR_META } from "../config/sectors.ts";
import { sectorCells } from "../config/universe.ts";
import { isNum, median, mean, round, zscores, zToScore } from "./stats.ts";

/**
 * 地域 × セクターの集計。
 *
 * リターンとテクニカルは代表 ETF から取る (セクター全体の値動きは
 * ETF がいちばん素直に代表する)。バリュエーションは ETF では取れないので
 * 構成銘柄の **中央値** を使う。平均だと 1 銘柄の高PERで全体が歪む。
 */

function med(xs: (number | null)[]): number | null {
  return round(median(xs.filter(isNum)), 4);
}

export function buildSectorAggregates(
  records: Record<string, InstrumentRecord>,
  sentiment: Map<string, SentimentResult> = new Map()
): SectorAggregate[] {
  const cells = sectorCells();
  const rows: SectorAggregate[] = [];

  for (const cell of cells) {
    const members = cell.members
      .map((m) => records[m.symbol])
      .filter((r): r is InstrumentRecord => !!r);
    if (members.length === 0) continue;

    const proxy = members.find((m) => m.instrument.role === "sector-proxy") ?? null;
    const constituents = members.filter((m) => m.instrument.role === "constituent");
    // ファンダは構成銘柄から、値動きは代表 ETF から。ETF が無ければ
    // 構成銘柄の中央値で代用する (等ウェイト近似であることを承知の上で)。
    const fundamentalPool = constituents.length > 0 ? constituents : members;

    const ret = (pick: (r: InstrumentRecord) => number | null): number | null =>
      proxy ? round(pick(proxy), 4) : med(members.map(pick));

    const meta = SECTOR_META[cell.sector];
    const above200 = members
      .map((m) => m.technicals.ma.above.sma200)
      .filter((x): x is boolean => x !== null);

    rows.push({
      region: cell.region,
      sector: cell.sector,
      nameJa: meta.nameJa,
      nameEn: meta.nameEn,
      proxySymbol: proxy?.instrument.symbol ?? null,
      memberCount: members.length,
      r1w: ret((r) => r.price.r1w),
      r1m: ret((r) => r.price.r1m),
      r3m: ret((r) => r.price.r3m),
      r12m: ret((r) => r.price.r12m),
      medianPE: med(fundamentalPool.map((r) => r.fundamentals?.trailingPE ?? null)),
      medianForwardPE: med(fundamentalPool.map((r) => r.fundamentals?.forwardPE ?? null)),
      medianPB: med(fundamentalPool.map((r) => r.fundamentals?.priceToBook ?? null)),
      medianEvEbitda: med(fundamentalPool.map((r) => r.fundamentals?.evToEbitda ?? null)),
      medianDividendYield: med(fundamentalPool.map((r) => r.fundamentals?.dividendYield ?? null)),
      medianROE: med(fundamentalPool.map((r) => r.fundamentals?.returnOnEquity ?? null)),
      medianRevenueGrowth: med(fundamentalPool.map((r) => r.fundamentals?.revenueGrowth ?? null)),
      meanTechnical: round(mean(members.map((m) => m.technicals.compositeScore).filter(isNum)), 1),
      meanRsi: round(mean(members.map((m) => m.technicals.rsi14).filter(isNum)), 1),
      pctAbove200dma:
        above200.length > 0
          ? round((above200.filter(Boolean).length / above200.length) * 100, 1)
          : null,
      medianComposite: med(members.map((m) => m.factors?.composite ?? null)),
      sentiment: sentiment.get(`${cell.region}/${cell.sector}`) ?? null,
      heat: null,
      spark: proxy?.spark.slice(-60) ?? members[0].spark.slice(-60),
    });
  }

  return assignHeat(rows);
}

/**
 * ヒートスコア。
 *
 * 「勢い (3ヶ月リターンとテクニカル)」「裾野 (200日線超え比率)」
 * 「割高感 (予想PERの逆張り成分)」の 3 つを地域内で標準化して合成する。
 * 地域内で標準化するのは、通貨と市場全体の水準差を落とすため。
 * 米国と日本を混ぜて Z を取ると、単に「その年に強かった国」の順位になる。
 */
function assignHeat(rows: SectorAggregate[]): SectorAggregate[] {
  const byRegion = new Map<string, SectorAggregate[]>();
  for (const r of rows) {
    const list = byRegion.get(r.region) ?? [];
    list.push(r);
    byRegion.set(r.region, list);
  }

  for (const list of byRegion.values()) {
    if (list.length < 2) {
      // 比較対象が無い地域でヒートを出しても意味が無い
      for (const r of list) r.heat = null;
      continue;
    }
    const z3m = zscores(list.map((r) => r.r3m), { winsorizeAt: 0.1 });
    const z1m = zscores(list.map((r) => r.r1m), { winsorizeAt: 0.1 });
    const zTech = zscores(list.map((r) => r.meanTechnical), { winsorizeAt: 0.1 });
    const zBreadth = zscores(list.map((r) => r.pctAbove200dma), { winsorizeAt: 0.1 });
    // 予想PER は「低いほど加点」だが、モメンタム重視の指標なので重みは軽く
    const zVal = zscores(
      list.map((r) => (isNum(r.medianForwardPE) ? -r.medianForwardPE : null)),
      { winsorizeAt: 0.1, robust: true }
    );

    list.forEach((r, i) => {
      const parts: [number | null, number][] = [
        [z3m[i], 1.2],
        [z1m[i], 0.8],
        [zTech[i], 1.0],
        [zBreadth[i], 0.6],
        [zVal[i], 0.4],
      ];
      let acc = 0;
      let w = 0;
      for (const [z, weight] of parts) {
        if (isNum(z)) {
          acc += z * weight;
          w += weight;
        }
      }
      r.heat = w > 0 ? zToScore(acc / w) : null;
    });
  }

  return rows.sort(
    (a, b) =>
      a.region.localeCompare(b.region) ||
      (b.heat ?? -1) - (a.heat ?? -1) ||
      a.sector.localeCompare(b.sector)
  );
}
