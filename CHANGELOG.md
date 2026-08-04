# Changelog

書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

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

### Changed

- `package.json` に `test` / `typecheck` スクリプトを追加。実行時の依存と
  デプロイ手順 (`npx wrangler deploy`) は変更なし。
- `src/` の実行時 import に `.ts` 拡張子を明示した (14 箇所)。拡張子なしの
  相対 import は Node の ESM リゾルバが解決できず、`src/datasources/rss.ts` の
  ように実行時 import を持つモジュールはテストから読み込めなかった。
  esbuild / wrangler の解決結果は変わらない (`wrangler deploy --dry-run` で確認)。

### Added (追補)

- `test/rss.test.ts` — RSS/Atom パーサのテスト 15 件。`parseFeed` は
  **第三者が本文を書ける入力**を解析する唯一の純粋関数で、SECURITY.md で
  攻撃面として挙げているにもかかわらず未検証だった。
  タグ除去・エンティティ経由で隠したマークアップの除去・壊れた XML での
  無例外性 (1 フィードの破損でパイプライン全体を止めない) を固定している。

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
