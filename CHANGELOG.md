# CHANGELOG

## 1.0.0 — 株式アナリティクスへの全面刷新

量子コンピューティングのシミュレーション層を全部撤去し、**地域 × セクターの株式分析
ターミナル**として作り直しました。QAOA も振幅推定も、株の良し悪しを判断する役には
立っていなかったので、そのぶんを実際にアナリストが見る指標の実装に充てています。

### 削除

- `src/quantum/` 全体 (statevector / gates / circuit / QAOA / IQAE / QUBO / stateprep)
- `src/os/` 全体 (kernel / backends / ledger / qpu — 量子優位性の計測台帳)
- `src/problems/` (基数制約付きバスケット選択、テールリスクの振幅推定)
- `src/engine/cosmology.ts` (Hurst 指数・パワースペクトル)、`src/engine/quantumGeometry.ts`
  (量子忠実度・Fubini-Study 距離)
- `bench/advantage.ts`、`research/` の Python 実験コード
- 関連テスト 12 本と、`/api/quantum/*` エンドポイント一式

### 追加 — 分析エンジン

- **`analytics/stats.ts`** 統計プリミティブ。頑健 Z スコア (中央値 + MAD)、
  ウィンザライズ、パーセンタイル順位 (同値は平均順位)、相関、単回帰、歪度、尖度。
  サンプル不足は `0` ではなく `null` を返す
- **`analytics/technicals.ts`** RSI / MACD / ボリンジャー (+%B・バンド幅パーセンタイル・
  スクイーズ) / ATR / ストキャス / ADX+DI / OBV / MFI / CCI / Williams %R / ROC / VWAP /
  移動平均 5-20-50-100-200 + クロス + パーフェクトオーダー / 古典・フィボナッチのピボット /
  スイング高安のクラスタリングによる支持抵抗帯 / RSI ダイバージェンス。
  平滑化は指標ごとに Wilder (α=1/n) と EMA (α=2/(n+1)) を使い分ける
- **`analytics/risk.ts`** 年率ボラ (20/60/252日)・下方偏差・β・α・R²・トラッキングエラー・
  情報比・上昇下落キャプチャ・最大ドローダウン・シャープ・ソルティノ・カルマー・
  歴史的 VaR/CVaR (95/99%)・歪度・尖度
- **`analytics/fundamentals.ts`** バリュー 9 指標・クオリティ 10 指標・グロース 5 指標の
  スコアカード。指標ごとに定義域を持ち、外れた値 (赤字企業の負の PER など) は欠損扱い
- **`analytics/factors.ts`** 5 ファクター (バリュー / クオリティ / モメンタム / グロース /
  低ボラ) の Z 段階での加重合成。モメンタムは 12-1 が主軸で、直近 1 ヶ月は短期リバーサルとして減点
- **`analytics/rotation.ts`** Z スコア正規化版 RS-Ratio / RS-Momentum と四象限判定
- **`analytics/correlation.ts`** 相関行列・冪乗法による第1主成分・相関距離の階層クラスタリング
- **`analytics/regime.ts`** トレンド / ボラティリティ / リスク選好を別々に判定し、根拠を開示
- **`analytics/breadth.ts`** 200日線超え比率・騰落レシオ・新高値新安値
- **`analytics/signals.ts`** 30 種類以上のシグナル生成 (全件に実数の根拠つき)
- **`analytics/screener.ts`** ドットパス指定のフィルタ・ソート DSL と 8 プリセット
- **`analytics/aggregate.ts`** 地域 × セクター集計とヒートスコア

### 追加 — データ層

- Yahoo Finance `/v8/finance/chart` を OHLCV 対応に拡張。**adjclose の調整比率を
  高安始値にも適用** し、配当落ちが下落として計上されるのを防止
- Yahoo Finance `/v10/finance/quoteSummary` を追加 (cookie + crumb 認証)。
  PER/PBR/ROE/利益率/成長率/アナリスト目標株価/レーティング分布を取得。
  crumb セッションは 6 時間キャッシュ
- Stooq を OHLCV 対応に拡張 (フォールバック)。配当調整なしを警告として記録
- `FetchBudget` — サブリクエスト上限の管理。予算切れは黙って諦めず理由を記録する

### 変更 — 実行モデル

- ユニバースを 8 シャードに分割し、cron (15分ごと) で 1 シャードずつ更新。
  価格系列は Durable Object に残るので、更新していない銘柄も横断分析には参加する
- Durable Object を `SnapshotStore` → `AnalyticsStore` に置き換え。
  1 値 128 KiB 上限に収まるよう、メタ / 銘柄レコード / 価格系列を別キーに分離
- ユニバースを 135 銘柄に拡大 (セクター ETF 40、個別株 66、ベンチマーク 17、マクロ 12)

### 変更 — API

`/api/quantum/*` を削除し、以下に置き換え:
`/api/overview` `/api/universe` `/api/sectors` `/api/screener` (GET/POST) `/api/presets`
`/api/symbol/{s}` `/api/compare` `/api/history/{s}` `/api/rotation` `/api/breadth`
`/api/regime` `/api/correlation` `/api/factors` `/api/news` `/api/meta`

### 変更 — ダッシュボード

5 タブ構成に全面刷新 (概況 / セクター / スクリーナー / ローテーション / リスク・相関) +
個別銘柄モーダル (価格チャート・出来高・RSI サブプロット・テクニカル内訳・スコアカード・
リスク・コンセンサス・シグナル・支持抵抗・ピア比較・データの出所)。

### テスト

107 テスト。RSI は Wilder の標準系列に対する手計算値と照合し、公表テーブルとの
0.07 のズレが元データの丸め由来であることまで検証しています。
ADX がトレンド相場でレンジ相場より高くなること、β が自己相関で 1 になること、
主成分の寄与率が単位行列で 1/n になること、欠損がスクリーニング条件に一致しないこと、
などを個別に検証しています。

---

## 0.2.0 (削除済み) — 量子OS版

セクター選択を基数制約付き QUBO として QAOA で解き、テールリスクを反復量子振幅推定で
見積もり、古典バックエンドと横並びで計測する「優位性台帳」を持っていたバージョン。

## 0.1.0 (削除済み) — 初版

セクターのヒートスコアランキングと、量子情報幾何 / 宇宙論的スペクトル指標。
