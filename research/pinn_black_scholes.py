"""
PINN (Physics-Informed Neural Network) × Black–Scholes PoC (PyTorch)
====================================================================

宇宙物理・流体力学のPDEソルバーとして生まれたPINNを金融PDEに適用する。
Black–Scholes 方程式:

    ∂V/∂t + (1/2)σ²S² ∂²V/∂S² + rS ∂V/∂S − rV = 0

を、境界条件 (満期ペイオフ) だけを教師にニューラルネットで解く。
解析解 (欧州コール) と比較して精度を検証する。

エッジ側では推論結果 (係数化した曲面) を配るのが役割分担:
学習は Colab (無料GPU) / エッジは配信のみ、で0円が成立する。

実行: python pinn_black_scholes.py   (CPUで1-2分)
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn as nn

torch.manual_seed(0)

# ---- 市場パラメータ (実運用では Worker の /api から取得した IV を渡す) ----
SIGMA = 0.25   # ボラティリティ
R = 0.04       # 無リスク金利
K = 100.0      # 行使価格
T = 1.0        # 満期 (年)
S_MAX = 300.0


class PINN(nn.Module):
    def __init__(self, hidden: int = 64, depth: int = 4):
        super().__init__()
        layers: list[nn.Module] = [nn.Linear(2, hidden), nn.Tanh()]
        for _ in range(depth - 1):
            layers += [nn.Linear(hidden, hidden), nn.Tanh()]
        layers += [nn.Linear(hidden, 1)]
        self.net = nn.Sequential(*layers)

    def forward(self, t: torch.Tensor, s: torch.Tensor) -> torch.Tensor:
        # 入力を [0,1] に正規化して安定化
        x = torch.cat([t / T, s / S_MAX], dim=1)
        return self.net(x)


def pde_residual(model: PINN, t: torch.Tensor, s: torch.Tensor) -> torch.Tensor:
    """Black–Scholes 演算子を自動微分で評価 (これが『物理制約』)"""
    t.requires_grad_(True)
    s.requires_grad_(True)
    v = model(t, s)
    grads = torch.autograd.grad(v.sum(), [t, s], create_graph=True)
    v_t, v_s = grads
    v_ss = torch.autograd.grad(v_s.sum(), s, create_graph=True)[0]
    return v_t + 0.5 * SIGMA**2 * s**2 * v_ss + R * s * v_s - R * v


def bs_analytic(t: np.ndarray, s: np.ndarray) -> np.ndarray:
    """解析解 (検証用)"""
    from scipy.stats import norm

    tau = np.maximum(T - t, 1e-9)
    d1 = (np.log(np.maximum(s, 1e-9) / K) + (R + 0.5 * SIGMA**2) * tau) / (
        SIGMA * np.sqrt(tau)
    )
    d2 = d1 - SIGMA * np.sqrt(tau)
    return s * norm.cdf(d1) - K * np.exp(-R * tau) * norm.cdf(d2)


def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = PINN().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)

    n_pde, n_bc = 4000, 800
    for epoch in range(3000):
        opt.zero_grad()

        # PDE 内点
        t_c = torch.rand(n_pde, 1, device=device) * T
        s_c = torch.rand(n_pde, 1, device=device) * S_MAX
        loss_pde = pde_residual(model, t_c, s_c).pow(2).mean()

        # 満期条件 V(T,S) = max(S-K, 0)
        s_T = torch.rand(n_bc, 1, device=device) * S_MAX
        t_T = torch.full_like(s_T, T)
        payoff = torch.clamp(s_T - K, min=0.0)
        loss_term = (model(t_T, s_T) - payoff).pow(2).mean()

        # 境界 V(t,0)=0, V(t,S_max)≈S_max − K e^{−r(T−t)}
        t_b = torch.rand(n_bc, 1, device=device) * T
        loss_low = model(t_b, torch.zeros_like(t_b)).pow(2).mean()
        upper = S_MAX - K * torch.exp(-R * (T - t_b))
        loss_high = (model(t_b, torch.full_like(t_b, S_MAX)) - upper).pow(2).mean()

        loss = loss_pde + 10 * loss_term + loss_low + loss_high
        loss.backward()
        opt.step()

        if epoch % 500 == 0:
            print(
                f"epoch {epoch:4d}  total={loss.item():.4f} "
                f"pde={loss_pde.item():.5f} terminal={loss_term.item():.4f}"
            )

    # ---- 解析解との比較 ----
    model.eval()
    s_test = np.linspace(50, 200, 7)
    t_test = np.zeros_like(s_test)  # 現在時点 t=0
    with torch.no_grad():
        v_pinn = (
            model(
                torch.tensor(t_test, dtype=torch.float32, device=device).unsqueeze(1),
                torch.tensor(s_test, dtype=torch.float32, device=device).unsqueeze(1),
            )
            .cpu()
            .numpy()
            .ravel()
        )
    v_true = bs_analytic(t_test, s_test)
    print("\n  S      PINN     解析解    誤差")
    for s, vp, vt in zip(s_test, v_pinn, v_true):
        print(f"{s:6.1f} {vp:8.3f} {vt:8.3f} {abs(vp - vt):7.3f}")
    rmse = math.sqrt(float(np.mean((v_pinn - v_true) ** 2)))
    print(f"\nRMSE vs analytic: {rmse:.4f}")


if __name__ == "__main__":
    main()
