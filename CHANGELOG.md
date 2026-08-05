# Changelog

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.2.0] — 2026-08-05

**量子OSの搭載。** v0.1 は「量子」を名乗りながら量子計算を一切していなかった
(`quantumGeometry.ts` は名前が量子的なだけの O(n) 古典統計量)。それ以前の問題として、
QAIZ が解いていた課題に計算量的な難しさが無く、**量子を挿す場所が原理的に存在しなかった**。
このリリースは「難しい問題を作る → 本物の量子計算を実装する → 勝敗を測る」の順で作り直した。

### Added

#### 量子仮想マシン (`src/quantum/`)

- `statevector.ts` — 状態ベクトルシミュレータ (最大22量子ビット)。任意の 1 量子ビットゲート、
  多重制御ゲート、対角ユニタリの一括適用、位相オラクル、測定サンプリング。
  ビット順はリトルエンディアン。Bell / GHZ 状態とユニタリ性をテストで固定。
- `sector.ts` — ハミング重み保存セクタに限定したシミュレータ。XY ミキサーと対角コストは
  どちらも粒子数を保存するので、2ⁿ 次元を持ち歩く必要が無い。n=16, K=6 で
  65,536 → 8,008 次元 (8.2倍削減)。完全な状態ベクトルとの一致を 1e-13 でテスト。
- `circuit.ts` — 回路 IR。シミュレータ用の融合実装と実機用の分解ゲート列を同じ命令が
  両方持つ構造にして、資源見積り (CX換算・深さ) の正確さを保った。逆回路、OpenQASM3 出力。
- `qaoa.ts` — QAOA / QAOA+。X ミキサー (ペナルティ方式) と XY リングミキサー
  (Hadfield et al. 2019、Dicke 初期状態、基数制約を保存則として満たす) の両方。
  目的関数は CVaR_α (Barkoutsos et al. 2020)。パラメータ最適化は Nelder-Mead。
- `iqae.ts` — 反復量子振幅推定 (Grinko et al. 2021)。Grover 演算子 Q = A S₀ A† S_χ、
  Chernoff-Hoeffding 信頼区間、区間の半周期への逆写像。
- `stateprep.ts` — 一様制御 RY による厳密な離散分布ロード (Möttönen 型)、閾値オラクル。
- `optimizer.ts` / `qubo.ts` / `gates.ts` / `rng.ts` — Nelder-Mead、QUBO↔Ising 変換、
  ゲート行列、決定論的 RNG。

#### 量子の出番がある問題 (`src/problems/`)

- `basket.ts` — **基数制約付きセクターバスケット選択** (NP困難)。
  `maximize μᵀx − λxᵀΣx s.t. |x|=K` を QUBO 化。
- `tailrisk.ts` — **バスケットのテールリスク推定**。振幅推定が
  二次高速化を証明済みの問題クラス (古典 Θ(1/ε²) vs 量子 O(1/ε))。

#### 量子OS (`src/os/`)

- `kernel.ts` — CPU 予算内でのバックエンド選択と実行、判定。
- `backends.ts` — 厳密列挙 (Gosper's hack)、焼きなまし (基数保存スワップ近傍)、QAOA。
- `ledger.ts` — **優位性台帳**。クエリ計算量と解の品質だけを優位性として計上し、
  シミュレータの壁時計時間は構造的に計上できないようにした。判定は
  `query-model` / `none` / `unverified` の 3 値。
- `qpu.ts` — 実機 QPU アダプタ。未設定なら明示的に unavailable を返す (ダミー結果は返さない)。
  不透明命令を含む回路は実機に投げない。

#### 配線・検証

- API 3 本を追加: `GET /api/basket`、`GET /api/quantum/ledger`、`GET /api/quantum/status`、
  `POST /api/quantum/solve` (第三者が優位性を再現できるよう μ/Σ を外から渡せる)。
- ダッシュボードに量子OSパネル (バスケット、VaR/CVaR、バックエンド横並び表、判定)。
- `bench/advantage.ts` — 優位性ベンチマーク。README の表はこの出力そのもの。
- テストを 61 → 184 に拡張。Grover 演算子が `sin²((2k+1)θ)` を 1e-12 で再現すること、
  IQAE のクエリ比が ε を細かくするほど伸びること (= 二次高速化そのもの) を含む。

### Changed

- **スナップショットに `quantum` を追加** — QAIZ の出力が「ランキング」から
  「実際に持つ K 本のバスケット + その尾リスク + 優位性台帳」になった。
- 永続化層に台帳キー (`ledger:v1`) を追加。スナップショットは上書きされるが台帳は積み上がる。
- `wrangler.toml` に `QUANTUM_BUDGET_MS` / `BASKET_CARDINALITY` / `TAIL_EPSILON` を追加。
  予算を超えたバックエンドは実行されず、その理由が台帳に残る。
- 焼きなましは予算切れでも最低 1 回は回すようにした (「解なし」を返すより粗い実行可能解を返す)。
- Nelder-Mead の打ち切り判定を `>` から `>=` に変更し、予算 0 の挙動を決定論にした。

### Notes

- `src/engine/quantumGeometry.ts` は**特徴量として残した**。市場レジーム指標としては機能し、
  ヒートスコアに効いている。ただし**優位性の主張には一切使っていない** — 古典統計量だから。
- 組合せ最適化側に現時点の優位性は**無い**。n=16 は厳密列挙が 1ms で終わる。
  QAIZ はそれを隠さず、毎回厳密解を並走させて近似比を台帳に書く。

## [0.1.2] — 2026-08-04

### Added

- `LICENSE` (MIT) と README のライセンス節。README は冒頭から「オープンソース」を
  謳っていたが、ライセンスの実体がなく利用条件が不明だった状態を解消。
  `package.json` の `"private": true` は npm への誤 publish 防止であって
  ソースの利用条件ではない旨も明記した。
- `CONTRIBUTING.md` — 3 層 (データソース / 数理エンジン / 配線) ごとの規約、
  数理エンジンの純粋性要件、無料枠の予算表。
- `SECURITY.md` — 非公開報告手順と、RSS/GDELT・Workers AI・公開 API という攻撃面の整理。
- `CHANGELOG.md` (このファイル)。
- 数理エンジンのユニットテスト (`test/`)。`node --test` のネイティブ TypeScript 実行を
  使い、**追加依存ゼロ**。値域・退化ケース・既知入力に対する既知出力を固定した。
- CI ワークフロー `ci.yml` — push / PR で `tsc --noEmit` と `npm test` を実行。
- `dependabot.yml` — npm と github-actions を週次で更新。
- CodeQL ワークフロー — push / PR / 週次で TypeScript を静的解析。

### Changed (0.1.2)

- `package.json` に `test` / `typecheck` スクリプトを追加。実行時の依存と
  デプロイ手順 (`npx wrangler deploy`) は変更なし。

## [0.1.1] — 2026-08-04

### Fixed

- ストレージを Workers KV から **Durable Object (SQLite)** に置き換え、デプロイ時に
  自動プロビジョニングされるようにした。KV の id を手で `wrangler.toml` に書く手順が
  消え、`npx wrangler deploy` だけで通るようになった。

## [0.1.0] — 2026-08-04

### Added

- 初回リリース。Cloudflare エッジ上のセクターモメンタム・レーダー一式:
  - 数理エンジン — 量子情報幾何 (忠実度 / Fubini-Study 距離 / QFI 近似 / 振幅エントロピー)、
    宇宙論スペクトル解析 (Hurst 指数 / スペクトル傾き)、マルチタイムフレーム・モメンタム、
    それらを合成する 0〜100 のヒートスコア。
  - データソース — Yahoo Finance (非公式) と Stooq フォールバック、RSS 6 フィード、GDELT。
    すべてキー不要・無料。
  - AI センチメント — Workers AI (Llama 3.1 8B)。無料枠超過時はレキシコンへ自動フォールバック。
  - REST API 6 本と、依存ゼロの単一 HTML ダッシュボード。
  - 毎時 cron による自動更新。
  - 研究層 `research/` — PennyLane による量子幾何テンソル、PINN による Black–Scholes 求解、
    CMB 流スペクトル解析の PoC。
