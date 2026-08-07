/**
 * テーマ / 供給網の定義。
 *
 * 相関やセクター分類は「結果として一緒に動いた」ことしか教えてくれない。
 * なぜ一緒に動くのか — 誰が誰に売っているのか、どちらが川上なのか — は
 * データから自動では出てこないので、ここに明示的に書く。
 *
 * `chain` は波及の順序。上流から下流に向かって書く。
 * AI データセンターなら「GPU が売れる → メモリが引っ張られる → 製造装置に
 * 発注が回る → 電力が足りなくなる」という順序があり、初心者にとって
 * いちばん知りたいのはこの順序そのもの。
 *
 * 銘柄はユニバースに存在するものだけを書く (テストで検証している)。
 */

import type { SectorId } from "../types.ts";

export interface ThemeLink {
  id: string;
  nameJa: string;
  /** このテーマが何で動くのか (一行) */
  driver: string;
  /** 初心者向け: 平たく言うと何のかたまりか */
  plain: string;
  /** 波及の順序。上流 → 下流 */
  chain: {
    stage: string;
    /** その段の代表銘柄 (ユニバース内) */
    symbols: string[];
    /** その段が何を担っているか */
    role: string;
  }[];
  /** このテーマが崩れるとしたら何が起きたときか */
  breaks: string;
  sectors: SectorId[];
}

export const THEMES: ThemeLink[] = [
  {
    id: "ai-datacenter",
    nameJa: "AI データセンター",
    driver: "生成AI向けサーバー投資 (ハイパースケーラーの設備投資)",
    plain:
      "AI を動かすための巨大なコンピュータ室を建てる話。誰かが GPU を買うと、その GPU に載せるメモリ、GPU を作る装置、そして動かすための電気まで芋づるで需要が伸びる。",
    chain: [
      { stage: "1. 設計・GPU", symbols: ["NVDA", "AVGO", "AMD"], role: "計算の中心。ここの受注が先行指標になる" },
      { stage: "2. メモリ", symbols: ["MU", "005930.KS"], role: "GPU 1枚あたりの搭載量が増えると数量以上に効く" },
      { stage: "3. 製造", symbols: ["2330.TW"], role: "実際に半導体を焼く。稼働率がそのまま利益率" },
      { stage: "4. 製造装置", symbols: ["ASML.AS", "8035.T"], role: "工場を増やすときに買われる。最も遅れて効く" },
      { stage: "5. 電力・冷却", symbols: ["NEE", "6501.T", "GE"], role: "データセンターの電力確保。近年ここが制約になり始めた" },
    ],
    breaks:
      "ハイパースケーラーが設備投資計画を下方修正したとき。GPU の受注残が減る前に、まず投資計画のガイダンスが動く。",
    sectors: ["semis", "tech", "utilities", "industrials"],
  },
  {
    id: "rate-sensitive",
    nameJa: "金利感応セクター",
    driver: "長期金利 (米10年債利回り) の方向",
    plain:
      "金利が上がると得する業種と損する業種がはっきり分かれる。銀行は貸出金利が上がって儲かり、不動産や公益は借金の利払いが増えて苦しくなる。金利ニュースの日にこの2グループが逆に動いていたら、それは正常。",
    chain: [
      { stage: "金利上昇で追い風", symbols: ["XLF", "KBE", "JPM", "BAC", "8306.T", "8766.T"], role: "利ざやが広がる。ただし景気後退が伴うと貸倒れで相殺される" },
      { stage: "金利上昇で逆風", symbols: ["XLRE", "XLU", "PLD", "NEE", "1628.T", "1627.T"], role: "借入コスト増 + 配当利回りの相対的な魅力低下" },
      { stage: "金利そのもの", symbols: ["^TNX", "^FVX", "TLT"], role: "原因側。ここを先に見る" },
    ],
    breaks:
      "金利上昇の理由が『景気が強い』から『信用不安』に変わったとき。同じ金利上昇でも銀行株の反応が逆になる。",
    sectors: ["financials", "banks", "realestate", "utilities"],
  },
  {
    id: "commodity-cycle",
    nameJa: "資源・インフレ連鎖",
    driver: "原油・銅などコモディティ価格",
    plain:
      "原油や銅が上がると、それを掘る会社は儲かるが、それを使う会社 (輸送・化学・小売) はコストが増えて苦しくなる。同じニュースで上がる株と下がる株が同時に出るのはこのため。",
    chain: [
      { stage: "1. 資源価格", symbols: ["CL=F", "HG=F", "GC=F"], role: "原因側" },
      { stage: "2. 掘る側 (恩恵)", symbols: ["XLE", "XOM", "CVX", "SHEL.L", "FCX", "1618.T"], role: "価格上昇がそのまま利益" },
      { stage: "3. 加工・素材", symbols: ["XLB", "LIN", "4063.T", "1620.T"], role: "転嫁できるかで明暗が分かれる" },
      { stage: "4. 使う側 (逆風)", symbols: ["XLY", "XLP", "KO", "PG", "7203.T"], role: "コスト増。値上げが通るかが焦点" },
    ],
    breaks:
      "供給要因 (減産・地政学) で上がっていた価格が、需要減速による下落に転じたとき。掘る側の株は資源価格より先に下げ始めることが多い。",
    sectors: ["energy", "materials", "staples", "discretionary"],
  },
  {
    id: "weak-yen",
    nameJa: "円安メリット / デメリット",
    driver: "ドル円 (日米の金利差が主因)",
    plain:
      "円が安くなると、海外で稼ぐ日本企業は同じ売上でも円換算で増える。逆に輸入に頼る企業は仕入れが高くなる。日本株を見るときはまずドル円を見る、というのはこの構造のため。",
    chain: [
      { stage: "為替", symbols: ["USDJPY=X"], role: "原因側" },
      { stage: "円安で追い風 (外需)", symbols: ["7203.T", "6758.T", "8035.T", "6861.T", "6501.T"], role: "海外売上比率が高いほど効く" },
      { stage: "円安で逆風 (内需・輸入)", symbols: ["1617.T", "1627.T", "9432.T"], role: "原材料・燃料の輸入コスト増" },
    ],
    breaks:
      "円安の理由が金利差から日本の信認低下に変わったとき。輸出企業の株価も一緒に売られるようになる。",
    sectors: ["discretionary", "tech", "semis", "staples", "utilities"],
  },
  {
    id: "defensive-shelter",
    nameJa: "ディフェンシブ退避先",
    driver: "景気後退懸念・株式全体のボラティリティ",
    plain:
      "景気が悪くなっても人は薬を飲むし電気も使うし歯磨き粉も買う。だから不況局面ではこれらの業種が『相対的に』強くなる。上がるという意味ではなく、下げが浅いという意味。",
    chain: [
      { stage: "退避先", symbols: ["XLP", "XLU", "XLV", "PG", "KO", "JNJ", "1617.T", "1621.T"], role: "需要が景気に左右されにくい" },
      { stage: "退避のシグナル", symbols: ["^VIX", "GC=F", "TLT"], role: "ここが動き出すと資金の向きが変わる" },
    ],
    breaks:
      "金利が急上昇したとき。ディフェンシブは配当利回りで買われている面があるため、債券利回りが上がると相対的な魅力を失う。",
    sectors: ["staples", "utilities", "health"],
  },
  {
    id: "defense-geopolitics",
    nameJa: "防衛・地政学",
    driver: "各国の国防予算と地政学リスク",
    plain:
      "紛争や緊張が高まると防衛関連の受注が増える。ただし株価は事件の当日ではなく『予算が組まれる』段階で動くので、ニュースを見てから買うと遅いことが多い。",
    chain: [
      { stage: "防衛", symbols: ["ITA", "RTX", "GE", "AIR.PA"], role: "受注は数年単位。四半期の業績より受注残を見る" },
      { stage: "資源への波及", symbols: ["CL=F", "GC=F", "XLE"], role: "供給不安を通じて価格に出る" },
    ],
    breaks: "停戦・緊張緩和。ただし一度組まれた予算は簡単には減らないので、業績の反応は株価より遅い。",
    sectors: ["defense", "industrials", "energy"],
  },
  {
    id: "consumer-health",
    nameJa: "個人消費の体温計",
    driver: "雇用・実質賃金・消費者信頼感",
    plain:
      "財布の紐が緩むと外食や旅行、家電が売れる。締まると生活必需品だけが残る。この2グループの強弱を比べると、景気の実感が数字で見える。",
    chain: [
      { stage: "余裕があるとき", symbols: ["XLY", "AMZN", "HD", "TSLA", "MC.PA", "7974.T"], role: "無くても困らないものが売れる" },
      { stage: "余裕がないとき", symbols: ["XLP", "COST", "KO", "PG", "ULVR.L"], role: "無いと困るものだけが残る" },
    ],
    breaks: "実質賃金がマイナスに転じたとき。名目の売上が伸びていても数量が落ちているケースがある。",
    sectors: ["discretionary", "staples"],
  },
  {
    id: "crypto-liquidity",
    nameJa: "暗号資産と流動性",
    driver: "金融環境の緩和度合い (実質金利・ドル)",
    plain:
      "ビットコインは『世の中にお金が余っているか』に最も素直に反応する資産のひとつ。株の中でも投機的な銘柄と似た動きをすることが多い。",
    chain: [
      { stage: "暗号資産", symbols: ["BTC-USD"], role: "流動性の体温計" },
      { stage: "似た動きをする株", symbols: ["TSLA", "^RUT"], role: "リスク許容度が高いときに買われる層" },
      { stage: "逆方向", symbols: ["DX-Y.NYB", "^TNX"], role: "ドル高・金利高は逆風" },
    ],
    breaks: "規制イベント。マクロと関係なく単独で動く局面が定期的に来る。",
    sectors: ["crypto", "tech"],
  },
];

/** 銘柄が属するテーマを引く */
export function themesFor(symbol: string): ThemeLink[] {
  return THEMES.filter((t) => t.chain.some((c) => c.symbols.includes(symbol)));
}

/** テーマ内で、指定銘柄と同じ段 / 別の段にいる銘柄を返す */
export function themeNeighbors(
  symbol: string
): { theme: ThemeLink; sameStage: string[]; otherStages: { stage: string; role: string; symbols: string[] }[] }[] {
  return themesFor(symbol).map((theme) => {
    const mine = theme.chain.find((c) => c.symbols.includes(symbol));
    return {
      theme,
      sameStage: (mine?.symbols ?? []).filter((s) => s !== symbol),
      otherStages: theme.chain
        .filter((c) => c !== mine)
        .map((c) => ({ stage: c.stage, role: c.role, symbols: c.symbols })),
    };
  });
}
