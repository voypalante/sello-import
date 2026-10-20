// Minimal ZIP reader (stored and deflated entries, ZIP64 sizes) on node:zlib, so the tool has no
// unzip dependency. Reads the central directory once; file data is inflated on demand.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

export function openZip(path) {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  // End of central directory: last 22 bytes plus a comment of up to 64 KB.
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { closeSync(fd); throw new Error(`${path} is not a ZIP file`); }
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64: the locator sits right before the classic record.
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const rec = readAt(fd, Number(tail.readBigUInt64LE(loc + 8)), 56);
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    let compressed = cd.readUInt32LE(p + 20);
    let uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')).replace(/\\/g, '/');
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(extra.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(extra.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { method, compressed, uncompressed, local, encrypted: Boolean(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...entries.keys()],
    size: (name) => entries.get(name)?.uncompressed,
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`${name} is not in the ZIP`);
      if (e.encrypted) throw new Error(`${name} is password protected in the ZIP`);
      const header = readAt(fd, e.local, 30);
      const start = e.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = readAt(fd, start, e.compressed);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRawSync(data);
      throw new Error(`${name} uses an unsupported ZIP compression (${e.method})`);
    },
    close: () => closeSync(fd),
  };
}
