const ZIP32_MAX = 0xffff_ffff;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

export interface ZipEntry {
  name: string;
  open: () => Promise<ReadableStream<Uint8Array>>;
}

interface CentralEntry {
  name: Uint8Array;
  crc32: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

export function streamText(value: string): ReadableStream<Uint8Array> {
  return new Blob([value], { type: "application/json" }).stream();
}

export function createZipStream(entries: ZipEntry[], modifiedAt = new Date()): {
  readable: ReadableStream<Uint8Array>;
  completed: Promise<void>;
} {
  if (entries.length > 0xffff) throw new Error("ZIP entry limit exceeded");
  const channel = new TransformStream<Uint8Array, Uint8Array>();
  const writer = channel.writable.getWriter();
  const encoder = new TextEncoder();
  const timestamp = toDosTimestamp(modifiedAt);

  const completed = (async () => {
    let offset = 0;
    const centralEntries: CentralEntry[] = [];
    const write = async (chunk: Uint8Array) => {
      await writer.write(chunk);
      offset += chunk.byteLength;
      if (offset > ZIP32_MAX) throw new Error("ZIP32 archive exceeds 4 GiB");
    };

    try {
      for (const entry of entries) {
        const name = encoder.encode(entry.name);
        if (name.byteLength === 0 || name.byteLength > 0xffff || entry.name.includes("\0")) {
          throw new Error("Invalid ZIP entry name");
        }

        const localOffset = offset;
        await write(localHeader(name, timestamp.dosTime, timestamp.dosDate));

        const source = await entry.open();
        const reader = source.getReader();
        let crc = 0xffff_ffff;
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            crc = updateCrc32(crc, value);
            size += value.byteLength;
            if (size > ZIP32_MAX) throw new Error(`ZIP entry exceeds 4 GiB: ${entry.name}`);
            await write(value);
          }
        } finally {
          reader.releaseLock();
        }

        const finalizedCrc = (crc ^ 0xffff_ffff) >>> 0;
        await write(dataDescriptor(finalizedCrc, size));
        centralEntries.push({
          name,
          crc32: finalizedCrc,
          size,
          offset: localOffset,
          dosTime: timestamp.dosTime,
          dosDate: timestamp.dosDate,
        });
      }

      const centralOffset = offset;
      for (const entry of centralEntries) await write(centralHeader(entry));
      const centralSize = offset - centralOffset;
      await write(endOfCentralDirectory(centralEntries.length, centralSize, centralOffset));
      await writer.close();
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {
        // The reader may already have cancelled the stream.
      }
      throw error;
    }
  })();

  return { readable: channel.readable, completed };
}

function updateCrc32(crc: number, chunk: Uint8Array): number {
  let value = crc;
  for (const byte of chunk) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function localHeader(name: Uint8Array, dosTime: number, dosDate: number): Uint8Array {
  const bytes = new Uint8Array(30 + name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_DATA_DESCRIPTOR_FLAGS, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint16(26, name.byteLength, true);
  bytes.set(name, 30);
  return bytes;
}

function dataDescriptor(crc32: number, size: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc32, true);
  view.setUint32(8, size, true);
  view.setUint32(12, size, true);
  return bytes;
}

function centralHeader(entry: CentralEntry): Uint8Array {
  const bytes = new Uint8Array(46 + entry.name.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_DATA_DESCRIPTOR_FLAGS, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.byteLength, true);
  view.setUint32(42, entry.offset, true);
  bytes.set(entry.name, 46);
  return bytes;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return bytes;
}

function toDosTimestamp(value: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, value.getUTCFullYear()));
  const dosTime = (value.getUTCHours() << 11) | (value.getUTCMinutes() << 5) | Math.floor(value.getUTCSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate();
  return { dosTime, dosDate };
}
