# notebooks/

**可視化・探索・結果確認にだけ使う。**

再利用可能なロジックを notebook に書かない (README 54)。
notebook のセルは実行順序に依存し、上から順に走らせても同じ結果になる保証が無い。
研究の再現性はここでは担保できない。

ロジックは `lab/qaiz_lab/` に置き、notebook からは import して使う。

```python
import sys; sys.path.insert(0, "../lab")
from qaiz_lab.providers.qaiz_pit import QaizPitProvider
from qaiz_lab.validation import quantile_returns
```

図を出すには matplotlib が要る (任意依存)。

```bash
cd lab && pip install -e ".[research]"
```
