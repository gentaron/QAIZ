# QAIZ Research Layer — 量子情報幾何 × 宇宙物理 × 金融の実験場

エッジ (Cloudflare Worker) に載せた数理エンジンの「本体研究版」。
すべて **無料** (ローカルCPU or Google Colab 無料枠) で動く。

| スクリプト | 内容 | 対応するエッジ実装 |
|---|---|---|
| `quantum_geometry_momentum.py` | PennyLane 変分量子回路 + 量子幾何テンソル (Fubini-Study計量) + 量子自然勾配法でセクター方向予測 | `src/engine/quantumGeometry.ts` (古典近似) |
| `pinn_black_scholes.py` | PINN で Black–Scholes PDE を求解し解析解と比較 | (将来: 学習済み曲面をエッジ配信) |
| `cosmo_spectral_market.py` | CMB流パワースペクトル解析 + Hurst指数 (R/S・DFA) で市場レジーム判定 | `src/engine/cosmology.ts` |

## セットアップ

```bash
pip install -r requirements.txt
python quantum_geometry_momentum.py
python pinn_black_scholes.py
python cosmo_spectral_market.py
```

Google Colab の場合はセルに `!pip install pennylane yfinance` 後、
各スクリプトを貼り付けるだけで動く (無料GPUは PINN の学習が高速化される)。

## 役割分担 (0円アーキテクチャの肝)

- **重い学習** (量子回路シミュレーション・PINN学習) → ローカル / Colab 無料枠
- **軽い推論・指標計算** (忠実度・FS距離・Hurst・スペクトル傾き) → エッジで古典近似をリアルタイム計算
- 学習で得たパラメータや係数はJSONにして Worker の KV に置けば、エッジから0円で配信できる

## 参考文献・OSS

- PennyLane: https://github.com/PennyLaneAI/pennylane (量子機械学習・QGT・QNG)
- Physics-Informed Neural Networks: Raissi, Perdikaris & Karniadakis (2019)
- 経済物理学とHurst解析: Mandelbrot の R/S 解析、Peng らの DFA
- Fubini-Study 計量と量子相転移検出: quantum fidelity susceptibility 文献群
