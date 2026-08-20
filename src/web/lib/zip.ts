const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function zipPath(input: string): string {
  const value = input.replace(/\\/g, "/").normalize("NFC");
  if (!value || value.startsWith("/") || value.includes("\0")) throw new Error(`非法 ZIP 路径：${input}`);
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`非法 ZIP 路径：${input}`);
  return value;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

export interface ZipEntryInput {
  path: string;
  data: Blob | ArrayBuffer | Uint8Array | string;
}

async function entryBytes(data: ZipEntryInput["data"]): Promise<Uint8Array> {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

export async function createStoredZip(entries: ZipEntryInput[]): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const entry of entries) {
    const path = zipPath(entry.path);
    const name = encoder.encode(path);
    const data = await entryBytes(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0x0800);
    u16(localView, 8, 0);
    u16(localView, 10, dosTime);
    u16(localView, 12, dosDate);
    u32(localView, 14, crc);
    u32(localView, 18, data.byteLength);
    u32(localView, 22, data.byteLength);
    u16(localView, 26, name.byteLength);
    u16(localView, 28, 0);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0x0800);
    u16(centralView, 10, 0);
    u16(centralView, 12, dosTime);
    u16(centralView, 14, dosDate);
    u32(centralView, 16, crc);
    u32(centralView, 20, data.byteLength);
    u32(centralView, 24, data.byteLength);
    u16(centralView, 28, name.byteLength);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, offset);
    central.set(name, 46);
    centrals.push(central);
    offset += local.byteLength;
  }

  const centralBytes = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  u32(eocdView, 0, 0x06054b50);
  u16(eocdView, 4, 0);
  u16(eocdView, 6, 0);
  u16(eocdView, 8, entries.length);
  u16(eocdView, 10, entries.length);
  u32(eocdView, 12, centralBytes.byteLength);
  u32(eocdView, 16, offset);
  u16(eocdView, 20, 0);

  return new Blob([...locals, centralBytes, eocd], { type: "application/zip" });
}

export interface ParsedZipEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  bytes: Uint8Array;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (
      bytes[offset] === 0x50
      && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05
      && bytes[offset + 3] === 0x06
    ) return offset;
  }
  throw new Error("ZIP 缺少中央目录结尾记录");
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (!("DecompressionStream" in globalThis)) throw new Error("当前浏览器不支持 ZIP Deflate 解压");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseZip(file: Blob, limits = { maxEntries: 500, maxTotalBytes: 100 * 1024 * 1024 }): Promise<ParsedZipEntry[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0) throw new Error("不支持多磁盘 ZIP");
  if (entries > limits.maxEntries) throw new Error(`ZIP 文件数超过 ${limits.maxEntries}`);

  const metadata: Array<{
    path: string;
    method: number;
    flags: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
  }> = [];
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 0x0001) throw new Error("不支持加密 ZIP");
    if (method !== 0 && method !== 8) throw new Error(`不支持 ZIP 压缩方法 ${method}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("第一版不支持 ZIP64");
    }
    const pathValue = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (pathValue.endsWith("/")) continue;
    const safePath = zipPath(pathValue);
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) throw new Error("ZIP 解压后总大小超过 100 MiB");
    metadata.push({ path: safePath, method, flags, crc, compressedSize, uncompressedSize, localOffset });
  }

  const output: ParsedZipEntry[] = [];
  for (const entry of metadata) {
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error(`ZIP 本地头损坏：${entry.path}`);
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
    const inflated = entry.method === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);
    if (inflated.byteLength !== entry.uncompressedSize) throw new Error(`ZIP 解压大小不匹配：${entry.path}`);
    if (crc32(inflated) !== entry.crc) throw new Error(`ZIP CRC32 校验失败：${entry.path}`);
    output.push({
      path: entry.path,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      bytes: inflated,
    });
  }
  return output;
}
