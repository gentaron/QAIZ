# CLAUDE.md — このリポジトリで作業するときの規約

QAIZ は 2 つの層でできている。**どちらを触っているかを常に意識すること。**

```
src/    QAIZ Worker      TypeScript / Cloudflare Workers 無料枠 / 現在を見る
lab/    qaiz_lab         Python / ローカルPC / 過去を検証する
configs/  両方が読む共有設定 (JSON。生成物を手で編集しない)
```

---

## 絶対原則

### 1. 未来の情報を使わない

過去の時点 `t` において市場参加者が知り得なかった情報を、`t` の特徴量にしない。

決算・財務・TDnet・ニュース・配当・自社株買い・分割・空売り残高・信用残高・
投資部門別売買・SNS・外部データについて、次の 3 つを必ず区別する。

```
effective_date  その情報がいつ時点の事実か
published_at    公表された時刻
available_at    我々が実際に使えるようになった時刻   ← バックテストが見てよいのはこれだけ
```

`available_at` を決められないデータは使わない。「たぶん翌日には見られたはず」で進めない。

### 2. 無料で成立させる

**明示的な承認なしに、有料 API / SaaS / クラウド / データベンダー / LLM API /
GPU / DB / バックテストサービスを導入しない。** APIキーが要るサービスも、
契約を前提にしない。

検討順序:

```
1. 無料  2. ローカル処理  3. オープンソース  4. 無料公開データ
5. 手動ダウンロード  6. 既存データ  7. 最後に有料
```

有料を提案するときは 4 点を必ず書く: `Why necessary / Free alternative /
Limitation of free alternative / Estimated cost`。
「このAPIを使えば簡単」は理由にならない。

### 3. 推測で実装しない

データ仕様が不明なら、公式ドキュメント → 公式API仕様 → リポジトリ内の既存コード →
実際のデータサンプル の順に確認する。確認できなければ `UNKNOWN` として扱い、
**そのデータを使う機能を実装しない**。

存在しない API・存在しない列名を想像して書かない。
列名を推測してリネームすると、対応が間違っていても全部 NaN になるだけで気付けない。

現在 `UNVERIFIED` のもの (一次情報に到達できていない):

- J-Quants Free プランのデータ期間・遅延・レートリミット・エンドポイント可否
- JPX 銘柄別信用取引週末残高のファイル仕様と公表スケジュール

これらは `probe()` で実測して初めて `available` になる。仮定してコードを書かない。

### 4. 良い結果より正しい認識

「この研究は失敗している」という結論を積極的に出す。
バックテストが悪ければ悪いと報告する。リーケージが疑われれば止める。
データが不足していれば「できない」と言う。

**儲かるバックテストを作るより、儲かるように見えるインチキバックテストを
見破るほうを優先する。**

---

## 触る前に読むもの

| やること | 先に読む |
|---|---|
| 何か変更する | `PROJECT_AUDIT.md` (現状・問題点・優先度) |
| 研究を始める | `RESEARCH_PROTOCOL.md` (13ステップと降り方) |
| データを足す | `DATA_DICTIONARY.md` (3つの日付・PIT の扱い) |
| 過去の研究を見る | `EXPERIMENT_LOG.md` (失敗も残っている) |

---

## 変更の進め方

大規模な書き換えをしない。

```
1. 現状を理解  2. 問題を特定  3. 修正方針を決定
4. 小さく変更  5. テスト      6. 次の変更
```

複雑な変更では、コードを書く前に `Problem / Cause / Design / Implementation /
Validation` を整理する。

### 「動いた」は完了ではない

完了条件:

- [ ] 実行成功
- [ ] テスト成功 (TS 126 件 + Python 92 件が全部緑)
- [ ] 結果確認
- [ ] データリーケージ確認
- [ ] 再現性確認
- [ ] ドキュメント更新

### 大きな変更のあとに自問すること

```
この変更で未来情報が入らないか？
計算結果は正しいか？
既存機能を壊していないか？
API料金が発生しないか？
無料制約に違反しないか？
不要な依存関係が増えていないか？
テストを書いたか？
再現可能か？
```

---

## Worker 側 (`src/`) の規約

既存コードが守っている 4 つの規律を崩さない。

1. **取れなかった値は `0` ではなく `null`。** 0 は「PER が 0 倍」という意味のある値。
   欠損と混ぜた瞬間にランキングが壊れ、データの無い銘柄が上位に並ぶ。
2. **推定値で穴を埋めない。** それらしい数字を入れたスクリーナーは、無いより有害。
   仮定を置いた派生指標は `fieldSources` に仮定ごと記録する。
3. **どの数字がどこから来たか開示する。**
4. **日付を突き合わせてからリターンを取る。** 末尾から n 本ずつ切り出すと、
   営業日のずれで系列が平行移動して相関が過小評価される。

### PIT ジャーナル (`src/pit.ts`) を壊さない

- `observed_at` は**実際に観測した時刻**。前回から引き継いだ値に今の時刻を付けない
- 1 日 1 観測・先勝ち。上書きすると「もっと早く知っていた」事実が消える
- 価格から再計算できる値を記録しない (再取得不能な値との区別が付かなくなる)

### 無料枠の制約

- 1 実行あたりサブリクエスト 50 本 (`FETCH_BUDGET=44` で内側に置いている)
- CPU 時間も有限。シャード分割で 1 回を軽く保つ
- Durable Object の 1 値あたり 128 KiB

---

## Lab 側 (`lab/`) の規約

### 依存を増やさない

必須は **numpy と pandas だけ**。それ以外は任意依存で、
無ければ `NotImplementedError` で明示的に止める。
**黙って別の実装にフォールバックしない** — 実験ログのモデル名が実際と食い違う。

`pandas.Series.corr(method="spearman")` は scipy を要求するので使わない。
順位に直してから Pearson を取る (同じ値になる)。

### 欠損を 0 で埋めない

Worker 側と同じ。ユニバース外も 0 ではなく NaN。

### 検証コードは「わざと壊したデータで落ちること」を確認する

正常系だけ通すテストは、何も検出しない空実装と区別が付かない。
`tests/test_leakage.py` が実例。

### 語彙の制約

結果の表現は `EVIDENCE_LEVELS` に限る。
「勝てる」「有望」「儲かる」は使わない。「AI が勝った」も禁止 —
AI がモメンタムを再現している可能性を先に検証する。

---

## 言語間パリティ

`src/analytics/stats.ts` と `lab/qaiz_lab/xsection.py` は**同じ計算をする**。
片方だけ変更すると CI が落ちる。

```bash
npm run export:shared          # TS 側からゴールデンベクタを再生成
cd lab && pytest tests/test_parity.py
```

これが無いと「画面で 72 点の銘柄を、研究では 65 点として検証していた」が起きる。
単なる整合性ではなく安全装置。

`configs/qaiz_universe.json` と `configs/parity_vectors.json` は生成物。
**手で編集しない。** CI がドリフトを検出する。

---

## コマンド

```bash
# Worker
npm run typecheck              # tsc (src と test/scripts の両方)
npm test                       # node --test (126件)
npm run export:shared          # configs/ の生成物を更新
npm run dev                    # wrangler dev
npm run deploy                 # wrangler deploy

# Lab
cd lab
python -m pytest -q                                   # 92件
ruff check .
python -m qaiz_lab.cli doctor                         # 環境と設定の確認
python -m qaiz_lab.cli probe --provider jquants       # データの可否を実測
python -m qaiz_lab.cli pit-sync --url <worker-url>    # PIT をローカルに退避
python -m qaiz_lab.cli dictionary                     # データ辞書を再生成
python -m qaiz_lab.cli run --experiment R001 --quick  # 研究を実行
python -m qaiz_lab.cli log                            # 実験ログ
```

## Git

コミットメッセージは `feat: / fix: / refactor: / test: / research: / docs:` 形式。
