# research/

研究の記録。**生成物であってコードではない。**

```
hypotheses/   事前登録した仮説 (configs/research/ の写しや補足)
experiments/  実験結果 JSON。experiments.log.save() が書く
reports/      最終レポート (Markdown)
figures/      図表
```

## experiments/ をコミットする理由

再現性の記録だから。結果 JSON には `run_context` (seed / git revision /
設定参照 / ライブラリ版) が入っていて、これが無いと「同じ結果が出る」を
主張できない。

**失敗した実験も消さない。** 消すと同じ仮説を再検証して「今度は良かった」を
採ってしまう。詳細は `../EXPERIMENT_LOG.md`。

例外は動作確認で回した合成データの実行結果で、これは市場に関する情報を
何も含まないので `.gitignore` している。

## 最終レポートの構成 (README 80)

```
Executive Summary / Hypothesis / Data / Methodology / Results /
Robustness / Transaction Cost / Factor Exposure / Failure Modes /
Limitations / Conclusion / Next Research
```
