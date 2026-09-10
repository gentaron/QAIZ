# DATA_DICTIONARY

このプロジェクトが扱うデータの定義。**3 つの日付を混同しないことが全て。**

```
effective_date  その情報が「いつ時点の事実か」     例: 金曜締めの信用残
published_at    公表された時刻                     例: 翌週火曜 16:30
available_at    我々が実際に使えるようになった時刻   例: 同上 (手動DLならさらに後)
```

バックテストが参照してよいのは **`available_at` だけ**。
`effective_date` で結合すると、公表前の数字で売買したことになる。

---

## 1. 銘柄マスター

`providers/normalize.listed_frame()` が正規化する。

| 列 | 型 | 説明 | 必須 |
|---|---|---|---|
| `code` | str | 銘柄コード。`7203.T` ではなく `7203` に正規化 | ○ |
| `name` | str | 銘柄名 | ○ |
| `market` | str | 市場区分 (プライム/スタンダード/グロース) | |
| `sector33` | str | JPX 33業種 | |
| `sector17` | str | JPX 17業種 | |
| `listing_date` | date | 上場日 | |
| `delisting_date` | date | 上場廃止日。**これが無いマスターは生存者バイアスを持つ** | |
| `lot_size` | int | 売買単位 (原則 100) | |
| `margin_code` | str | 信用区分 (貸借銘柄かどうか) | |

`delisting_date` を持つ銘柄が 1 件も無い場合、
`build_universe()` は `survivorship_bias: "PRESENT"` を診断に刻む。
黙って進めない。

## 2. 日次価格

`providers/normalize.quotes_frame()` が正規化する。

| 列 | 型 | 説明 |
|---|---|---|
| `date` | date | 営業日 |
| `code` | str | 銘柄コード |
| `open` `high` `low` `close` | float | **未調整**の生値 |
| `volume` | float | 出来高 (株数) |
| `turnover` | float | 売買代金 (円)。無ければ `close × volume` で近似し、その旨を `attrs["mode"]` に記録 |
| `adjustment_factor` | float | 日次の調整係数。無ければ調整せず `adjustment_mode="none"` |

### 調整済み価格について

`build_price_panel()` は生値と調整済みの**両方**を保持する。

- **リターン計算** → 調整済み (`adj_close` / `adj_open`)
- **株価水準そのものを使う特徴量** (低位株判定など) → 生値 (`close`)

調整済み終値は分割のたびに過去が遡及的に書き換わるので、
**それ自体は Point-in-Time ではない**。リターンの計算には影響しないが、
水準を使う場面では生値を使う必要がある。

累積調整係数は「その日より**後**に起きた全調整の積」として、
末尾から逆向きに累積する (末尾 = 1.0、直近株価は生値と一致)。

### 品質検査 (`_sanity_prices`)

負の価格 / 負の出来高 / 高値 < 安値 / `(date, code)` の重複 / 未来日付。
1 つでも該当すれば `SchemaError` で止める。

## 3. 週次信用取引残高 (Research 001 の主データ)

`providers/normalize.margin_frame()` が PIT テーブルに直す。

| 列 | 説明 |
|---|---|
| `code` | 銘柄コード |
| `effective_date` | 基準日 (申込日付。原則 金曜) |
| `available_at` | **公表規則から生成**。基準日の第2営業日 16:30 JST + 保守側 1 営業日 |
| `margin_long` | 信用買残 |
| `margin_short` | 信用売残 |

> **公表規則は UNVERIFIED。** 本リポジトリを作成した環境から JPX の
> 公表スケジュールページへ到達できず、一次情報で確認できていない。
> 確認するまで R001 の実データ実行は行わない。
> 規則は `configs/research/r001_margin.json` の `availability` で変更できる。

### 混同してはいけないもの

```
信用買残 (margin_long)      買い建ての未決済残高。将来の売り圧力
信用売残 (margin_short)     売り建ての未決済残高。将来の買い戻し圧力
空売り残高 (short_interest) 機関投資家の空売り報告。制度信用の売残とは別物
空売り比率 (short_ratio)    出来高に占める空売りの割合 = フロー。残高ではない
```

残高 (ストック) とフローを混ぜると、意味の違う系列を平均することになる。

### 陳腐化

`max_staleness_days=60`。60 日を超えて更新の無い観測は使わない。
公表が止まっている (整理銘柄・上場廃止) ことを意味するため。

## 4. QAIZ PIT ジャーナル

Worker (`src/pit.ts`) が記録し、`providers/qaiz_pit.py` が読む。
**この統合の中核**であり、他では無料で手に入らないデータ。

| 列 | 説明 |
|---|---|
| `date` | 観測日 (JST の暦日) |
| `symbol` | Yahoo シンボル (`7203.T`) |
| `observed_at` | **Worker が実際に値を観測した時刻** (UTC)。これがそのまま `available_at` |
| `source` | 出所 (yahoo) |
| `schema_version` | スキーマ版 |
| `fundamentals` | 下記 24 項目 |
| `consensus` | 下記 7 項目 |

記録する `fundamentals` (再取得不能なものだけ):

```
trailingPE forwardPE priceToBook priceToSales evToEbitda
earningsYield fcfYield dividendYield payoutRatio
returnOnEquity returnOnAssets returnOnInvestedCapital
grossMargin operatingMargin profitMargin
debtToEquity netDebtToEbitda currentRatio
revenueGrowth earningsGrowth earningsQuarterlyGrowth
marketCap sharesOutstanding shortPercentOfFloat
```

記録する `consensus`:

```
recommendationMean analystCount targetMean targetMedian
upsideToTarget targetDispersion ratingMomentum
```

**記録しないもの**: 価格・テクニカル・リターン・リスク指標・ファクタースコア。
すべて価格系列から後で再計算できる。混ぜると
「再取得不能な観測」と「単なるキャッシュ」の区別が付かなくなる。

### 制約 (正直に)

- 記録開始日より前は存在しない。**過去のバックテストには使えない**
- シャード巡回なので 1 銘柄あたりの観測は 2 時間に 1 回程度、記録は 1 日 1 回 (先勝ち)
- 出所は Yahoo Finance。値そのものの正確性は保証されない
- ユニバースは QAIZ の 135 銘柄。日本株の全銘柄ではない
- DO の保持は 400 日。超過分はプルーニングされるので、
  `cli pit-sync` でローカルに退避しないと**消えた観測は再構成できない**

---

## 5. 特徴量

以下の表は **コードから自動生成される**
(`python -m qaiz_lab.cli dictionary`)。手で編集しない。

各特徴量は `FeatureSpec` として定義と同じ場所にメタデータを持つので、
実装を変えれば表も変わる。CI が同期を検査する。

<!-- FEATURES:BEGIN -->

| 特徴量 | 分類 | 定義 | 出所 | lookback | 利用可能時点 | ver |
|---|---|---|---|---|---|---|
| `log_adv_20d` | liquidity | 20営業日平均売買代金の対数 | 日次OHLCV (調整済み終値) | 20 | D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。 | 1.0.0 |
| `margin_long_chg_20d` | margin | 信用買残の20営業日 (≒4週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 20 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_long_chg_5d` | margin | 信用買残の5営業日 (≒1週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 5 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_long_chg_60d` | margin | 信用買残の60営業日 (≒12週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 60 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_long_to_adv` | margin | 信用買残 / 20日平均売買代金 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) + 日次OHLCV | 20 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_long_to_mktcap` | margin | 信用買残 / 時価総額 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) + 銘柄マスター | — | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_ratio` | margin | 信用倍率 = 信用買残 / 信用売残 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | — | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_short_chg_20d` | margin | 信用売残の20営業日 (≒4週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 20 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_short_chg_5d` | margin | 信用売残の5営業日 (≒1週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 5 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_short_chg_60d` | margin | 信用売残の60営業日 (≒12週) 変化率 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) | 60 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_short_to_adv` | margin | 信用売残 / 20日平均売買代金 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) + 日次OHLCV | 20 | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `margin_short_to_mktcap` | margin | 信用売残 / 時価総額 | JPX 銘柄別信用取引週末残高 (または J-Quants weekly_margin_interest) + 銘柄マスター | — | 基準日(金曜)の第2営業日 16:30 JST 公表 + 保守側に1営業日。**公表規則は一次情報で未検証 (configs/research/r001_margin.json の availability を参照)** | 1.0.0 |
| `mom_12_1` | momentum | 直近1ヶ月を除く12ヶ月リターン | 日次OHLCV (調整済み終値) | 252 | D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。 | 1.0.0 |
| `rev_5d` | momentum | 5営業日リターンの符号反転 (短期反転) | 日次OHLCV (調整済み終値) | 5 | D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。 | 1.0.0 |
| `beta_252d` | price | TOPIX に対する252日ローリングβ | 日次OHLCV (調整済み終値) + ベンチマーク | 252 | D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。 | 1.0.0 |
| `vol_60d` | volatility | 60営業日の実現ボラティリティ (年率) | 日次OHLCV (調整済み終値) | 60 | D営業日の大引け時点で確定。執行は翌営業日 (ExecutionConvention)。 | 1.0.0 |

<!-- FEATURES:END -->

---

## 6. ターゲット

`labels.build_targets()` が生成する。命名規則は `fwd{h}_{variant}`。

| 名前 | 定義 |
|---|---|
| `fwd{h}_raw` | 約定日 E から E+h の単純リターン |
| `fwd{h}_market_excess` | 上記 − ユニバース等ウェイト平均 |
| `fwd{h}_sector_excess` | 上記 − 業種平均 (その日その業種が 5 銘柄未満なら NaN) |

E は `ExecutionConvention` で決まる。既定は
「D 営業日の大引け時点の情報で判断 → D+1 の始値で約定」。

`fwd20_raw` の 20 は**営業日**であって暦日ではない。

---

## 7. コストモデル

`configs/costs.jp.json` — **全て仮定であり実測ではない**。

| 項目 | 既定 | 意味 |
|---|---|---|
| `commission.bps` | 5.0 | 片道 0.05% |
| `commission.floor_jpy` | 0 | 最低手数料。小口キャパシティに効く |
| `spread.bps` | 5.0 | ハーフスプレッド |
| `impact.coefficient_bps` | 10.0 | `impact = coef × sqrt(発注額 / ADV)` |
| `borrow.annual_fee_bps` | 150 | 貸株料 (年率)。逆日歩は表現できていない |
| `settlement.lot_size` | 100 | 売買単位 |

呼値の階段モデル (`use_tick_table`) は**未実装**。
`true` にすると `NotImplementedError` で止まる。
黙って bps 近似にフォールバックすると、低位株のコストを大幅に過小評価したまま
気付けなくなるため。

---

## 8. メタデータの規約

加工後データには必ず以下を持たせる。

```
source          どこから来たか
retrieved_at    取得時刻
effective_date  事実の時点
available_at    使えるようになった時刻
schema_version  スキーマ版
```

これらが無いデータは、後から検証できない = 研究に使えない。
