"""
量子情報幾何 × セクターモメンタム PoC (PennyLane)
==================================================

エッジ (Cloudflare Worker) 側の TypeScript 実装は「古典近似」だが、
ここでは本物の変分量子回路を使って:

  1. セクターETFのリターン特徴量を角度エンコーディングで量子状態化
  2. 量子幾何テンソル (Fubini-Study 計量) Q_{μν} を qml.metric_tensor で計算
  3. 自然勾配法 (QNG) で「翌週の上昇/下落」を予測する変分分類器を学習
  4. 学習した状態間の忠実度から市場レジームマップを描く

実行: python quantum_geometry_momentum.py  (CPUシミュレータで数分 / 無料)
Colab: そのまま貼り付けで動作。
"""

from __future__ import annotations

import numpy as np
import pennylane as qml
from pennylane import numpy as pnp

try:
    import yfinance as yf
except ImportError:
    yf = None

N_QUBITS = 4
N_LAYERS = 3
WINDOW = 20  # 特徴量窓 (営業日)
HORIZON = 5  # 予測ホライズン (1週間)

dev = qml.device("default.qubit", wires=N_QUBITS)


# ---------------------------------------------------------------- data
def load_returns(symbol: str = "XLK", period: str = "2y") -> np.ndarray:
    """セクターETFの対数リターン。yfinance が無ければ合成データで代替。"""
    if yf is not None:
        try:
            close = yf.download(symbol, period=period, progress=False)["Close"]
            close = np.asarray(close).ravel()
            r = np.diff(np.log(close))
            if len(r) > 100:
                return r
        except Exception as e:  # ネットワーク遮断環境など
            print(f"[warn] yfinance failed ({e}); using synthetic data")
    rng = np.random.default_rng(42)
    # トレンド + レジーム切替を含む合成リターン
    regimes = np.repeat(rng.choice([0.0005, -0.0003, 0.001], 12), 42)
    return regimes + rng.normal(0, 0.01, len(regimes))


def make_features(returns: np.ndarray):
    """窓ごとの特徴量 (平均・ボラ・歪度・直近リターン) とラベル (翌週上昇=1)"""
    X, y = [], []
    for i in range(WINDOW, len(returns) - HORIZON):
        w = returns[i - WINDOW : i]
        feat = [
            w.mean() * 100,
            w.std() * 100,
            float(((w - w.mean()) ** 3).mean() / (w.std() ** 3 + 1e-12)),
            w[-5:].sum() * 100,
        ]
        X.append(feat)
        y.append(1.0 if returns[i : i + HORIZON].sum() > 0 else -1.0)
    X = np.array(X)
    # 角度エンコーディング用に [-π/2, π/2] へスケール
    X = np.arctan(X / (np.abs(X).std(axis=0) + 1e-9))
    return X, np.array(y)


# ---------------------------------------------------------------- circuit
def ansatz(x, weights):
    qml.AngleEmbedding(x, wires=range(N_QUBITS), rotation="Y")
    for layer in range(N_LAYERS):
        for q in range(N_QUBITS):
            qml.RY(weights[layer, q, 0], wires=q)
            qml.RZ(weights[layer, q, 1], wires=q)
        for q in range(N_QUBITS - 1):
            qml.CNOT(wires=[q, q + 1])


@qml.qnode(dev, interface="autograd")
def classifier(x, weights):
    ansatz(x, weights)
    return qml.expval(qml.PauliZ(0))


@qml.qnode(dev, interface="autograd")
def state_node(x, weights):
    ansatz(x, weights)
    return qml.state()


def fidelity(psi1: np.ndarray, psi2: np.ndarray) -> float:
    return float(np.abs(np.vdot(psi1, psi2)) ** 2)


# ---------------------------------------------------------------- train
def main() -> None:
    returns = load_returns()
    X, y = make_features(returns)
    split = int(len(X) * 0.8)
    Xtr, ytr, Xte, yte = X[:split], y[:split], X[split:], y[split:]
    print(f"samples: train={len(Xtr)} test={len(Xte)}")

    weights = pnp.array(
        0.1 * np.random.default_rng(0).standard_normal((N_LAYERS, N_QUBITS, 2)),
        requires_grad=True,
    )

    def cost(w):
        pred = pnp.stack([classifier(x, w) for x in Xtr[:120]])
        return pnp.mean((pred - ytr[:120]) ** 2)

    # 量子自然勾配 (QNG): Fubini-Study 計量 Q_{μν} の逆行列で勾配を前処理。
    # これが「量子情報幾何を最適化に使う」ことの実体。
    opt = qml.QNGOptimizer(stepsize=0.08, approx="block-diag")
    for step in range(30):
        # QNGOptimizer は単一引数コストを想定
        weights = opt.step(lambda w: cost(w), weights)
        if step % 5 == 0:
            print(f"step {step:3d}  cost={float(cost(weights)):.4f}")

    # 評価
    pred = np.sign([float(classifier(x, weights)) for x in Xte])
    acc = float((pred == yte).mean())
    print(f"\ntest directional accuracy: {acc:.3f} (baseline 0.5)")

    # 量子幾何テンソル (Fubini-Study 計量) を1点で表示
    mt_fn = qml.metric_tensor(classifier, approx="block-diag")
    Q = mt_fn(Xtr[0], weights)
    print(f"\nFubini-Study metric tensor shape: {np.shape(Q)}")
    print("diagonal (parameter sensitivities):")
    print(np.round(np.diag(np.reshape(Q, (weights.size, weights.size))), 4))

    # レジームマップ: 学習済み回路が生成する状態間の忠実度行列
    idx = np.linspace(0, len(Xte) - 1, min(8, len(Xte)), dtype=int)
    states = [np.asarray(state_node(Xte[i], weights)) for i in idx]
    F = np.array([[fidelity(a, b) for b in states] for a in states])
    print("\nregime fidelity map (1=同一レジーム, 低=レジーム転換):")
    print(np.round(F, 2))


if __name__ == "__main__":
    main()
