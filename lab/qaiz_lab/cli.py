"""コマンドラインインタフェース。

    python -m qaiz_lab.cli doctor              環境と設定の健全性チェック
    python -m qaiz_lab.cli probe --provider …  データが実際に取れるかを実測
    python -m qaiz_lab.cli pit-sync --url …    Worker の PIT ジャーナルを取り込む
    python -m qaiz_lab.cli dictionary          DATA_DICTIONARY.md の表を再生成
    python -m qaiz_lab.cli run --experiment R001   研究を再現実行する
    python -m qaiz_lab.cli log                 実験ログの要約

`run --experiment R001` で同じ結果が再現できることを目標にしている
(README 92)。再現に必要なもの — シード・設定・git revision — は
結果 JSON の `run_context` に全部入る。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import CONFIG_DIR, DATA_DIR, REPO_ROOT, git_revision


def cmd_doctor(args: argparse.Namespace) -> int:
    """依存・設定・データの有無を確認する。"""
    ok = True
    print("== 環境 ==")
    print(f"  python        : {sys.version.split()[0]}")
    print(f"  git revision  : {git_revision()}")

    for mod, required in [("numpy", True), ("pandas", True), ("pyarrow", False),
                          ("sklearn", False), ("lightgbm", False), ("matplotlib", False)]:
        try:
            m = __import__(mod)
            print(f"  {mod:<14}: {getattr(m, '__version__', '?')}")
        except ImportError:
            mark = "必須 — 未インストール" if required else "任意 (未インストール)"
            print(f"  {mod:<14}: {mark}")
            ok &= not required

    print("\n== 設定 ==")
    for name in ["universe.jp.json", "costs.jp.json", "research/r001_margin.json",
                 "parity_vectors.json"]:
        p = CONFIG_DIR / name
        status = "OK" if p.exists() else "見つからない"
        print(f"  {name:<28}: {status}")
        ok &= p.exists()

    print("\n== データ ==")
    for sub in ["raw", "normalized", "point_in_time", "features", "cache"]:
        p = DATA_DIR / sub
        n = len(list(p.glob("**/*"))) if p.exists() else 0
        print(f"  data/{sub:<16}: {'無し' if not p.exists() else f'{n} 件'}")

    print("\n== 無料構成の確認 ==")
    print("  有料サービスへの依存: 無し (J-Quants Free / Stooq / QAIZ Worker のみ)")
    print("  J-Quants Free の制約: データ期間約2年・約12週遅延 (二次情報。要一次確認)")
    print("  → 遅延が事実なら、この構成で作れるのは『研究用シグナル』であって")
    print("     『実運用シグナル』ではない。Paper Trading に進む前に要検討。")

    print("\n" + ("すべて OK" if ok else "不足がある (上記を参照)"))
    return 0 if ok else 1


def cmd_probe(args: argparse.Namespace) -> int:
    """データソースが実際に使えるかを実測して記録する。"""
    if args.provider == "jquants":
        from .providers.jquants import JQuantsProvider

        report = JQuantsProvider().probe(sample_date=args.date)
    elif args.provider == "qaiz":
        from .providers.qaiz_pit import QaizPitProvider

        report = QaizPitProvider(base_url=args.url, archive_path=args.archive).probe()
    else:
        print(f"未知のプロバイダ: {args.provider}", file=sys.stderr)
        return 2

    out = json.dumps(report.to_dict(), ensure_ascii=False, indent=2)
    print(out)
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(f"\n→ {args.out} に保存", file=sys.stderr)
    return 0 if report.available else 1


def cmd_pit_sync(args: argparse.Namespace) -> int:
    """Worker の PIT ジャーナルをローカルにアーカイブする。

    Worker 側の Durable Object には保持上限があるので、定期的に
    ローカルへ吸い出す。**吸い出していない期間は永久に埋まらない。**
    """
    from .providers.qaiz_pit import QaizPitProvider

    provider = QaizPitProvider(base_url=args.url)
    raw = provider.fetch_ndjson(start=args.start, end=args.end)

    dest = Path(args.out or (DATA_DIR / "point_in_time" / "qaiz_journal.ndjson"))
    dest.parent.mkdir(parents=True, exist_ok=True)

    existing = set()
    if dest.exists():
        with dest.open(encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                    existing.add((r["date"], r["symbol"], r["observed_at"]))
                except (json.JSONDecodeError, KeyError):
                    continue

    added = 0
    with dest.open("a", encoding="utf-8") as f:
        for rec in raw.to_dict("records"):
            key = (rec.get("date"), rec.get("symbol"), rec.get("observed_at"))
            if key in existing:
                continue
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            existing.add(key)
            added += 1

    print(f"取得 {len(raw)} 件 / 新規追加 {added} 件 → {dest}")
    print("追記のみ。既存の観測は書き換えない (PIT の履歴が壊れるため)。")
    return 0


def cmd_dictionary(args: argparse.Namespace) -> int:
    """DATA_DICTIONARY.md の特徴量セクションを再生成する。"""
    from .features import REGISTRY

    table = REGISTRY.build_dictionary()
    marker_start = "<!-- FEATURES:BEGIN -->"
    marker_end = "<!-- FEATURES:END -->"
    path = REPO_ROOT / "DATA_DICTIONARY.md"

    if not path.exists():
        print(f"{path} が無い", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    if marker_start not in text or marker_end not in text:
        print(f"{path} にマーカー {marker_start} が無い", file=sys.stderr)
        return 1

    head, rest = text.split(marker_start, 1)
    _, tail = rest.split(marker_end, 1)
    new = head + marker_start + "\n\n" + table + "\n" + marker_end + tail

    if new == text:
        print("変更なし")
        return 0
    if args.check:
        print("DATA_DICTIONARY.md がコードと同期していない。"
              "`python -m qaiz_lab.cli dictionary` を実行して commit すること。",
              file=sys.stderr)
        return 1
    path.write_text(new, encoding="utf-8")
    print(f"{path} を更新した ({len(REGISTRY.names())} 特徴量)")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    """研究を実行する。"""
    if args.experiment.upper() != "R001":
        print(f"未実装の実験: {args.experiment} (現在は R001 のみ)", file=sys.stderr)
        return 2

    from .experiments import r001_margin

    if args.source == "synthetic":
        from .providers.synthetic import SyntheticConfig, make_market

        print("【合成データモード】市場に関する主張は一切生成されない。配管の検証のみ。\n")
        market = make_market(SyntheticConfig(
            n_codes=args.codes, n_days=args.days, margin_effect=args.effect,
        ))
        inputs = r001_margin.R001Inputs(
            bars=market["bars"],
            margin_raw=market["margin_raw"],
            sectors=market["sectors"],
            listed=market["listed"],
            is_synthetic=True,
            provenance={"dataset_version": f"synthetic:{market['config'].seed}"},
        )
    else:
        print(
            "実データモードは、信用残データの列定義を一次情報で確認してから有効にする。\n"
            "現状 configs/research/r001_margin.json の known_blockers に記載のとおり、\n"
            "  - JPX 銘柄別信用取引週末残高のファイル仕様\n"
            "  - J-Quants Free プランでの weekly_margin_interest の可否\n"
            "が未確認。確認せずに走らせると、列の取り違えで『予測力が無い』という\n"
            "誤った結論が出る。まず `cli probe --provider jquants` を実行すること。",
            file=sys.stderr,
        )
        return 3

    out = r001_margin.run(inputs, quick=args.quick, capital_jpy=args.capital)
    res = out["result"]
    print(f"\n== {res['experiment_id']}: {res['title']} ==")
    print(f"  状態        : {res['status']}")
    print(f"  証拠の強さ  : {res['evidence_level']}")
    print(f"  試行回数    : {res['n_tests_run']}")
    print(f"  結論        : {res['conclusion']}")
    print(f"  結果        : {out['result_path']}")
    return 0


def cmd_log(args: argparse.Namespace) -> int:
    from .experiments import log as experiment_log

    entries = experiment_log.load_all()
    if not entries:
        print("実験の記録はまだ無い。")
        return 0
    print(f"記録された実験: {len(entries)} 件 / 試行回数合計: {experiment_log.count_trials()}")
    print("(この試行回数合計が、Deflated Sharpe Ratio に渡すべき n_trials の下限)\n")
    for e in entries[-args.limit:]:
        flag = "合成" if e.get("data_is_synthetic") else "実データ"
        print(f"  {e['created_at'][:10]}  {e['experiment_id']:<8} {e['status']:<12} "
              f"{e['evidence_level']:<22} [{flag}] n={e.get('n_tests_run')}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="qaiz_lab", description="日本株クオンツ研究ラボ")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="環境と設定の健全性チェック").set_defaults(fn=cmd_doctor)

    pr = sub.add_parser("probe", help="データソースの可否を実測する")
    pr.add_argument("--provider", default="jquants", choices=["jquants", "qaiz"])
    pr.add_argument("--date", default=None, help="サンプル取得に使う日付 (YYYY-MM-DD)")
    pr.add_argument("--url", default=None, help="QAIZ Worker のベースURL")
    pr.add_argument("--archive", default=None, help="ローカルの PIT アーカイブ")
    pr.add_argument("--out", default=None, help="結果 JSON の保存先")
    pr.set_defaults(fn=cmd_probe)

    ps = sub.add_parser("pit-sync", help="Worker の PIT ジャーナルを取り込む")
    ps.add_argument("--url", required=True, help="QAIZ Worker のベースURL")
    ps.add_argument("--start", default=None)
    ps.add_argument("--end", default=None)
    ps.add_argument("--out", default=None)
    ps.set_defaults(fn=cmd_pit_sync)

    pd_ = sub.add_parser("dictionary", help="DATA_DICTIONARY.md を再生成")
    pd_.add_argument("--check", action="store_true", help="更新せず差分の有無だけ検査 (CI用)")
    pd_.set_defaults(fn=cmd_dictionary)

    rn = sub.add_parser("run", help="研究を実行する")
    rn.add_argument("--experiment", required=True, help="実験ID (例: R001)")
    rn.add_argument("--source", default="synthetic", choices=["synthetic", "real"])
    rn.add_argument("--quick", action="store_true", help="lookback/horizon を絞って高速実行")
    rn.add_argument("--capital", type=float, default=10_000_000)
    rn.add_argument("--codes", type=int, default=60, help="合成データの銘柄数")
    rn.add_argument("--days", type=int, default=500, help="合成データの日数")
    rn.add_argument("--effect", type=float, default=0.0,
                    help="合成データに埋め込む効果の強さ (0=無効果)")
    rn.set_defaults(fn=cmd_run)

    lg = sub.add_parser("log", help="実験ログの要約")
    lg.add_argument("--limit", type=int, default=20)
    lg.set_defaults(fn=cmd_log)

    args = p.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    raise SystemExit(main())
