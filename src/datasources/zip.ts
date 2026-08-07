/**
 * 最小限の ZIP リーダー。
 *
 * Ken French Data Library は全ファイルを ZIP で配布している。Workers には
 * `DecompressionStream` はあるが対応形式は gzip / deflate / deflate-raw の
 * 3 つで、**ZIP コンテナ自体は展開できない**。
 *
 * 幸い ZIP の中身の圧縮方式は事実上 deflate (method 8) か無圧縮 (method 0)
 * なので、コンテナのヘッダを自前で読んでデータ部を切り出せば、
 * あとは `DecompressionStream("deflate-raw")` に渡すだけで済む。
 * 必要なのはヘッダの読み取りだけで、展開アルゴリズムは書かなくてよい。
 *
 * 対応範囲は意図的に狭い:
 *   - 暗号化なし
 *   - ZIP64 なし (4GB 未満)
 *   - method 0 (stored) と 8 (deflate) のみ
 * Ken French の配布物はすべてこの範囲に収まる。範囲外は例外にして、
 * 黙って壊れたデータを返さないようにする。
 */

const EOCD_SIG = 0x06054b50; // End of Central Directory
const CEN_SIG = 0x02014b50; // Central Directory File Header
const LOC_SIG = 0x04034b50; // Local File Header

export interface ZipEntry {
  name: string;
  /** 0 = 無圧縮, 8 = deflate */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** ローカルヘッダの先頭オフセット */
  localOffset: number;
}

/** 末尾から End of Central Directory を探す */
function findEocd(view: DataView): number {
  // コメント長は最大 65535。末尾 22 バイトが最小の EOCD。
  const max = Math.min(view.byteLength, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const at = view.byteLength - i;
    if (at < 0) break;
    if (view.getUint32(at, true) === EOCD_SIG) return at;
  }
  return -1;
}

/** 中央ディレクトリを読んでエントリ一覧を返す */
export function listZipEntries(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("ZIP: End of Central Directory が見つからない");

  const count = view.getUint16(eocd + 10, true);
  const cenOffset = view.getUint32(eocd + 16, true);
  if (cenOffset >= buf.byteLength) throw new Error("ZIP: 中央ディレクトリの位置が不正");

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength) throw new Error("ZIP: 中央ディレクトリが途中で切れている");
    if (view.getUint32(p, true) !== CEN_SIG) throw new Error("ZIP: 中央ディレクトリの署名が不正");
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(buf, p + 46, nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** エントリのデータ部 (圧縮されたまま) を切り出す */
function rawData(buf: ArrayBuffer, entry: ZipEntry): Uint8Array {
  const view = new DataView(buf);
  const p = entry.localOffset;
  if (view.getUint32(p, true) !== LOC_SIG) throw new Error("ZIP: ローカルヘッダの署名が不正");
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  // 中央ディレクトリのサイズを信用する (ローカルヘッダ側は
  // データディスクリプタ使用時に 0 が入っていることがある)
  const end = start + entry.compressedSize;
  if (end > buf.byteLength) throw new Error("ZIP: データ部がファイル末尾を超えている");
  return new Uint8Array(buf, start, entry.compressedSize);
}

/** 1 エントリを展開してバイト列で返す */
export async function extractEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const data = rawData(buf, entry);
  if (entry.method === 0) return data;
  if (entry.method !== 8) {
    throw new Error(`ZIP: 未対応の圧縮方式 ${entry.method} (対応は 0=stored / 8=deflate のみ)`);
  }
  // ZIP の deflate は zlib ヘッダを持たない生の deflate ストリーム
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * ZIP から 1 ファイルをテキストとして取り出す。
 * `pick` を省略すると最初のエントリ (ディレクトリを除く) を取る。
 */
export async function readZipText(
  buf: ArrayBuffer,
  pick?: (entries: ZipEntry[]) => ZipEntry | undefined
): Promise<{ name: string; text: string }> {
  const entries = listZipEntries(buf).filter((e) => !e.name.endsWith("/"));
  if (entries.length === 0) throw new Error("ZIP: ファイルエントリが無い");
  const entry = pick ? pick(entries) : entries[0];
  if (!entry) throw new Error("ZIP: 目的のエントリが見つからない");
  const bytes = await extractEntry(buf, entry);
  return { name: entry.name, text: new TextDecoder().decode(bytes) };
}
