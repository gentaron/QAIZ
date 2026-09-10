# qaiz_lab — 日本株クオンツ研究ラボ

ローカル PC で動く研究側。QAIZ Worker (`../src/`) と対になる。

```
Worker (TypeScript)  現在の観測・可視化・PIT ジャーナルの記録
Lab    (Python)      過去の検証・仮説の反証・バックテスト     ← ここ
```

**必須依存は numpy と pandas だけ。** ネットワークも API キーも無しで
全テストが通る (合成データで完結している)。

---

## セットアップ

```bash
cd lab
pip install -e ".[dev]"          # numpy / pandas / pytest / ruff
python -m qaiz_lab.cli doctor    # 環境と設定の確認
```

任意依存 (無くても全機能が動く):

```bash
pip install -e ".[research]"     # scikit-learn / LightGBM / matplotlib / pyarrow
```

無い場合、該当機能は `NotImplementedError` で明示的に止まる。
黙って別のモデルにフォールバックしない — 実験ログのモデル名が実際と食い違うため。

---

## 5 分で動かす

```bash
# 合成データで研究パイプラインを端から端まで回す
python -m qaiz_lab.cli run --experiment R001 --quick

# 埋め込んだ信号を検出できるか確認する
python -m qaiz_lab.cli run --experiment R001 --effect 0.004

# 実験ログを見る
python -m qaiz_lab.cli log
```

**合成データの結果は市場に関する主張を一切含まない。** 配管が通っていることと、
埋め込んだ信号を検出できることの確認だけ。結論には自動で但し書きが付く。

---

## 構成

```
qaiz_lab/
├── pit.py            available_at による as-of 結合。ここが壊れたら全部無意味
├── calendar.py       価格から導出する営業日カレンダー / 執行規約
├── prices.py         価格パネル / コーポレートアクション (生値 + 調整係数)
├── universe.py       生存者バイアスを避けるユニバース構築
├── labels.py         ラベル生成 (約定日 → 満期日)
├── costs.py          手数料 + スプレッド + 平方根則インパクト
├── portfolio.py      中立化・制約・分位ウェイト
├── backtest.py       クロスセクショナル L/S + キャパシティ曲線
├── leakage.py        リーケージ自動検出 (切り詰め整合・定数列・未来時刻)
├── metrics.py        CAGR/ボラ/シャープ/ソルティノ/MaxDD/カルマー/VaR ...
├── xsection.py       TS 側 stats.ts の移植 (パリティ検証つき)
├── features/         特徴量 + レジストリ (定義とメタデータを同居させる)
├── models/           ベースライン (等ウェイト/乱数/モメンタム/反転/低ボラ/Ridge)
├── validation/       IC / 分位 / WalkForward / PurgedCV / ストレス / DSR・PBO
├── providers/        J-Quants / QAIZ PIT / 正規化 / 合成データ
└── experiments/      実験ログ + Research 001
```

---

## 設計の要点

### 1. `available_at` がすべて

```python
table.asof_panel(decision_at, codes)   # available_at <= 判断時刻 の最新1行
```

`effective_date` で結合してはいけない。金曜締めの信用残を翌火曜の公表前から
使えることになり、そのぶんだけリターンが水増しされる。
**しかも数字が綺麗に出るので気付きにくい。**

判断時刻は**時刻**で比較する。日付だけで比べると、
「公表 16:30 / 大引け 15:00」の 1 時間半が消える。

### 2. 執行ラグを強制する

```
シグナル日 D → 約定日 D+1 の始値 → 満期日 D+1+h の始値
```

`execution_lag_sessions=0` (引けで判断して同じ引けで約定) は例外で弾く。
物理的に不可能な仮定で、シャープが数倍になる。

### 3. リーケージ検出は「わざと壊したデータで落ちること」を確認する

```python
truncation_consistency(build, source, test_dates)
```

過去だけを渡して計算し直し、同じ値になるか確かめる。ならなければ未来を見ている。
`StandardScaler().fit_transform(全期間)` のような 1 行を機械的に暴く。

### 4. 乱数ベースラインが基準

乱数シグナルのシャープがゼロ近傍にならなければ、**評価系のバグ**。
戦略の問題ではない。テストで常時検証している。

### 5. 試行回数を数える

1008 通り試して最良を選べば、ノイズからでもシャープ 1.5 は出る。
`deflated_sharpe_ratio(returns, n_trials=...)` で割り引く。
`n_trials` は事前登録の `planned_tests` と実験ログの実績の大きいほう。

### 6. TS 側と同じ数字を出す

`xsection.py` は `src/analytics/stats.ts` の移植。
`configs/parity_vectors.json` を両言語のテストが検査する。

```bash
cd .. && npm run export:shared      # TS 側からゴールデンベクタを再生成
cd lab && pytest tests/test_parity.py
```

これが無いと「画面で 72 点の銘柄を、研究では 65 点として検証していた」が起きる。

---

## PIT ジャーナルの取り込み (Worker との接続)

Worker が 15 分ごとに観測している予想 PER・目標株価・レーティングは、
**後から過去分を取得できない**。記録していない日は永久に埋まらない。

```bash
# Worker の蓄積状況を見る
curl https://<worker>/api/pit/status

# ローカルに退避 (追記のみ。既存の観測は書き換えない)
python -m qaiz_lab.cli pit-sync --url https://<worker>
```

DO の保持は 400 日。超えるとプルーニングされるので、週 1 回は退避する。

```python
from qaiz_lab.providers.qaiz_pit import QaizPitProvider

p = QaizPitProvider(archive_path="../data/point_in_time/qaiz_journal.ndjson")
table = p.to_pit_table(kind="fundamentals")
print(table.coverage())
```

`observed_at` がそのまま `available_at` になる。推定でも規則からの逆算でもないので、
PIT としては最も厳密な部類になる。

---

## テスト

```bash
python -m pytest -q
ruff check .
```

テストの意図:

| ファイル | 何を守っているか |
|---|---|
| `test_pit.py` | 公表前の値が使えないこと。陳腐化した観測を使わないこと |
| `test_leakage.py` | 検出器がわざと壊したデータで**落ちる**こと |
| `test_labels_costs.py` | シグナル日の価格からリターンを測っていないこと |
| `test_backtest_portfolio.py` | 制約が再正規化で解けないこと。乱数のシャープが 0 近傍 |
| `test_validation.py` | ノイズから選んだ最良が DSR で棄却されること |
| `test_parity.py` | TypeScript と同じ数字を出すこと |
| `test_experiments.py` | 効果ゼロの世界で \|IC\| が 0.10 未満に収まること (実測 0.049) |
| `test_features.py` | 全特徴量に `availability` があること |

---

## 実データを使うには

**現時点では実データモードを開けていない。** 理由は
`configs/research/r001_margin.json` の `known_blockers` に書いてある。

```
1. JPX 銘柄別信用取引週末残高のファイル仕様 (列定義・期間・公表時刻) が未確認
2. J-Quants Free で weekly_margin_interest が使えるかが未確認
```

確認せずに走らせると、列の取り違えで全部 NaN になり
「信用残に予測力は無かった」という誤った結論が出る。そしてその結論は正しく見える。

確認の手順:

```bash
export JQUANTS_REFRESH_TOKEN=...        # 無料プランでも要る
python -m qaiz_lab.cli probe --provider jquants --out probe.json
```

`probe` は各エンドポイントを実際に 1 回ずつ叩き、使えたものだけを記録する。
「使えるはず」で実装していないので、使えなければ研究側が例外で止まる。
