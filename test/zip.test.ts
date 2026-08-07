import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { extractEntry, listZipEntries, readZipText } from "../src/datasources/zip.ts";

/**
 * ZIP リーダーの検証。
 *
 * ライブラリを使わず自前で ZIP を組み立てて食わせる。既存の zip コマンドに
 * 頼ると、環境によって生成されるバイト列が変わってテストが不安定になる。
 * ここで作るバイト列は仕様そのままなので、どこで動かしても同じ。
 */

function u16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

interface FileSpec {
  name: string;
  content: Buffer;
  /** 0 = stored, 8 = deflate */
  method: 0 | 8;
}

/** 単純な ZIP を組み立てる (暗号化・ZIP64 なし) */
function buildZip(files: FileSpec[]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  for (const f of files) {
    const nameBytes = [...enc.encode(f.name)];
    const data = f.method === 8 ? zlib.deflateRawSync(f.content) : f.content;
    const crc = zlib.crc32 ? zlib.crc32(f.content) : 0;
    offsets.push(locals.length);

    locals.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(f.method),
      ...u16(0), ...u16(0), // time/date
      ...u32(crc), ...u32(data.length), ...u32(f.content.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...data
    );
  }

  files.forEach((f, i) => {
    const nameBytes = [...enc.encode(f.name)];
    const data = f.method === 8 ? zlib.deflateRawSync(f.content) : f.content;
    const crc = zlib.crc32 ? zlib.crc32(f.content) : 0;
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(f.method),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(f.content.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offsets[i]),
      ...nameBytes
    );
  });

  const cenOffset = locals.length;
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(central.length), ...u32(cenOffset), ...u16(0),
  ];
  return new Uint8Array([...locals, ...central, ...eocd]).buffer;
}

test("ZIP: deflate 圧縮された単一ファイルを展開できる", async () => {
  const text = "date,value\n20260101,1.23\n20260102,-0.45\n".repeat(200);
  const buf = buildZip([{ name: "data.csv", content: Buffer.from(text, "utf8"), method: 8 }]);

  const entries = listZipEntries(buf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "data.csv");
  assert.equal(entries[0].method, 8);
  // 圧縮が効いていることも確認 (効いていなければテストの前提が壊れている)
  assert.ok(entries[0].compressedSize < entries[0].uncompressedSize);

  const out = await readZipText(buf);
  assert.equal(out.name, "data.csv");
  assert.equal(out.text, text);
});

test("ZIP: 無圧縮 (stored) も読める", async () => {
  const text = "hello,世界\n";
  const buf = buildZip([{ name: "plain.txt", content: Buffer.from(text, "utf8"), method: 0 }]);
  const out = await readZipText(buf);
  assert.equal(out.text, text);
});

test("ZIP: 複数エントリから目的のファイルを選べる", async () => {
  const buf = buildZip([
    { name: "readme.txt", content: Buffer.from("ignore me"), method: 8 },
    { name: "F-F_Research_Data_Factors_daily.CSV", content: Buffer.from("A,B\n1,2\n"), method: 8 },
  ]);
  const entries = listZipEntries(buf);
  assert.equal(entries.length, 2);

  const picked = await readZipText(buf, (es) => es.find((e) => /\.csv$/i.test(e.name)));
  assert.equal(picked.name, "F-F_Research_Data_Factors_daily.CSV");
  assert.equal(picked.text, "A,B\n1,2\n");
});

test("ZIP: 大きめのデータでも壊れずに往復する", async () => {
  // Ken French の日次ファイルは 1 万行超。分割して読む経路が
  // 壊れていないことを確認する
  const rows: string[] = ["date,Mkt-RF,SMB,HML,RMW,CMA,RF"];
  for (let i = 0; i < 20000; i++) {
    rows.push(`2026${String((i % 12) + 1).padStart(2, "0")}01,${(i % 7) - 3}.${i % 100},0.1,-0.2,0.3,0.05,0.01`);
  }
  const text = rows.join("\n");
  const buf = buildZip([{ name: "big.csv", content: Buffer.from(text, "utf8"), method: 8 }]);
  const out = await readZipText(buf);
  assert.equal(out.text.length, text.length);
  assert.equal(out.text, text);
});

test("ZIP: 壊れた入力は黙って通さず例外にする", async () => {
  const notZip = new Uint8Array(100).buffer;
  assert.throws(() => listZipEntries(notZip), /End of Central Directory/);

  // 未対応の圧縮方式は「空データ」ではなく例外にする
  const buf = buildZip([{ name: "x", content: Buffer.from("abc"), method: 0 }]);
  const entries = listZipEntries(buf);
  await assert.rejects(
    () => extractEntry(buf, { ...entries[0], method: 12 }),
    /未対応の圧縮方式/
  );
});
