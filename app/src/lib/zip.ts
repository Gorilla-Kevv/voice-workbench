/**
 * 极简 ZIP 打包器（仅 STORE 模式，不压缩）。
 *
 * WAV 为 PCM 音频，改用 deflate 收益有限，而 STORE 模式实现简单、无第三方依赖、
 * 打包速度极快，足够满足「多段语音一次性导出」的需求：解压后即为可播放的 wav 文件。
 *
 * 结构参考 PKWARE APPNOTE：
 *   [本地文件头 + 数据] × N → [中央目录] → [中央目录结束记录]
 */

/** CRC32 查表，ZIP 要求每个文件条目提供校验值 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 转换为 MS-DOS 格式的日期与时间（ZIP 规范要求） */
function toDosDateTime(date: Date): { time: number; date: number } {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff,
  };
}

export interface ZipEntry {
  /** 压缩包内文件名，建议使用 ASCII 或 UTF-8（已置 UTF-8 标志位） */
  name: string;
  /** 需为独占 ArrayBuffer 的视图，以匹配 BlobPart 的类型约束 */
  data: Uint8Array<ArrayBuffer>;
}

/** 把若干文件打包为 ZIP Blob */
export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const stamp = toDosDateTime(new Date());

  const localChunks: Uint8Array<ArrayBuffer>[] = [];
  const centralChunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const size = entry.data.length;

    // ---- 本地文件头 ----
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // 签名
    localView.setUint16(4, 20, true); // 解压所需版本 2.0
    localView.setUint16(6, 0x0800, true); // 标志位：文件名为 UTF-8
    localView.setUint16(8, 0, true); // 压缩方式：0 = 不压缩
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, size, true); // 压缩后大小
    localView.setUint32(22, size, true); // 原始大小
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // 扩展字段长度
    local.set(nameBytes, 30);

    localChunks.push(local, entry.data);

    // ---- 中央目录记录 ----
    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); // 签名
    centralView.setUint16(4, 20, true); // 创建版本
    centralView.setUint16(6, 20, true); // 解压所需版本
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, stamp.time, true);
    centralView.setUint16(14, stamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // 扩展字段
    centralView.setUint16(32, 0, true); // 注释长度
    centralView.setUint16(34, 0, true); // 起始磁盘号
    centralView.setUint16(36, 0, true); // 内部属性
    centralView.setUint32(38, 0, true); // 外部属性
    centralView.setUint32(42, offset, true); // 本地头偏移
    central.set(nameBytes, 46);

    centralChunks.push(central);
    offset += local.length + size;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);

  // ---- 中央目录结束记录 ----
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true); // 当前磁盘号
  endView.setUint16(6, 0, true); // 中央目录起始磁盘号
  endView.setUint16(8, entries.length, true); // 本磁盘条目数
  endView.setUint16(10, entries.length, true); // 总条目数
  endView.setUint32(12, centralSize, true); // 中央目录大小
  endView.setUint32(16, offset, true); // 中央目录偏移
  endView.setUint16(20, 0, true); // 注释长度

  return new Blob([...localChunks, ...centralChunks, end], { type: 'application/zip' });
}

/** Blob → 字节数组，供打包使用 */
export async function blobToBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.arrayBuffer());
}
