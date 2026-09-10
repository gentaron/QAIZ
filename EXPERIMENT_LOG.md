# EXPERIMENT_LOG

すべての研究の記録。**失敗した研究も消さない** (README 48)。

消すと、半年後に同じ仮説を思いついて同じ検証をやり直す。そのとき偶然良い結果が出れば
採用してしまう — これは「同じ仮説を 2 回試して良かったほうを採る」という、
最も分かりやすい過適合である。

`n_tests` 列の合計が、Deflated Sharpe Ratio に渡すべき試行回数の**下限**になる。
`python -m qaiz_lab.cli log` で集計できる。

## 記録の仕方

`lab/qaiz_lab/experiments/log.py` の `save()` が自動で追記する。手で書かない。
詳細は `research/experiments/*.json` に残り、そこに以下が全部入る。

```
Experiment ID / Date / Hypothesis / Dataset version / Feature version / Model version /
Training period / Validation period / Test period / Parameters / Transaction costs /
Metrics / Conclusion / Failure reason / n_tests_run / run_context (seed・git revision)
```

## 証拠の強さの語彙

```
robust evidence      DSR ≥ 0.95 かつ 乱数に勝ち かつ 単調
predictive evidence  DSR ≥ 0.90 かつ 乱数に勝ち
weak evidence        |t(Newey-West)| > 2
inconclusive         上記のいずれでもない
insufficient evidence 評価に足るデータが無い / 合成データによる配管テスト
likely overfit       DSR < 0.50
no evidence          効果が見られない
```

「勝てる」「有望」「儲かる」は使わない。

## 完全 OOS を見た記録

**完全 OOS 期間を見たら、ここに日付とともに記録すること。**
一度でも見て意思決定に使ったら、その期間は OOS ではなくなる。

| 日付 | 実験ID | 期間 | 見た理由 | その後の扱い |
|---|---|---|---|---|
| — | — | — | まだ 1 度も見ていない | — |

---

| 日付 | ID | 状態 | 証拠の強さ | データ | n_tests | 結論 | 詳細 |
|---|---|---|---|---|---|---|---|
<!-- APPEND BELOW -->
