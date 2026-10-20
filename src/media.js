// Photos and videos are prepared like the Sello web app does before upload: location and other
// metadata are removed, and photos browsers can't show (HEIC) become JPEG. A photo that can't be
// cleaned is refused rather than uploaded with its location inside.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

export const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.3gp': 'video/3gpp',
};

export const mimeOf = (name) => MIME_BY_EXT[extname(name).toLowerCase()] ?? null;
export const isMedia = (name) => mimeOf(name) !== null;
export const kindOf = (mime) => (mime.startsWith('video/') ? 'video' : 'image');

/** JPEG without APP1 (EXIF, XMP), APP13 (IPTC) and comments. */
export function stripJpeg(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  const out = [b.subarray(0, 2)];
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error('broken JPEG');
    const marker = b[p + 1];
    if (marker === 0xda) { out.push(b.subarray(p)); return Buffer.concat(out); } // image data follows
    const len = b.readUInt16BE(p + 2);
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!drop) out.push(b.subarray(p, p + 2 + len));
    p += 2 + len;
  }
  throw new Error('broken JPEG');
}

/** PNG without eXIf and text chunks. */
export function stripPng(b) {
  const sig = b.subarray(0, 8);
  if (sig.toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  const out = [sig];
  let p = 8;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(type)) out.push(b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

/** WebP without EXIF and XMP chunks (the VP8X flags for them are cleared too). */
export function stripWebp(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP');
  const chunks = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const type = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const total = 8 + len + (len & 1);
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = Buffer.from(b.subarray(p, p + total));
      if (type === 'VP8X') c[8] &= ~(0x08 | 0x04);
      chunks.push(c);
    }
    p += total;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** MP4/MOV with the metadata boxes (moov/udta, moov/meta: where it was filmed) blanked in place. */
export function stripMp4(input) {
  const b = Buffer.from(input);
  const walk = (start, end, inMovie) => {
    let o = start;
    while (o + 8 <= end) {
      let size = b.readUInt32BE(o);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = Number(b.readBigUInt64BE(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header || o + size > end) return;
      const t = b.toString('latin1', o + 4, o + 8);
      if (inMovie && (t === 'udta' || t === 'meta')) {
        b.write('free', o + 4, 'latin1');
        b.fill(0, o + header, o + size);
      } else if (t === 'moov' || t === 'trak') {
        walk(o + header, o + size, true);
      }
      o += size;
    }
  };
  walk(0, b.length, false);
  return b;
}

let magick;
function imageMagick() {
  if (magick === undefined) {
    magick = null;
    for (const cmd of ['magick', 'convert']) {
      if (spawnSync(cmd, ['-version']).status === 0) { magick = cmd; break; }
    }
  }
  return magick;
}

/** HEIC/HEIF/AVIF to a JPEG without metadata, with ImageMagick when it's installed. */
function toJpeg(bytes, ext) {
  const cmd = imageMagick();
  if (!cmd) throw new Error('HEIC/AVIF photos need ImageMagick installed (magick or convert) to become JPEG');
  const dir = mkdtempSync(join(tmpdir(), 'sello-import-'));
  try {
    const src = join(dir, `in${ext}`);
    const dst = join(dir, 'out.jpg');
    writeFileSync(src, bytes);
    const r = spawnSync(cmd, [src, '-auto-orient', '-strip', '-quality', '90', dst]);
    if (r.status !== 0) throw new Error(`ImageMagick couldn't convert it: ${String(r.stderr).trim().split('\n')[0]}`);
    return readFileSync(dst);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** {bytes, mime, kind} ready to encrypt and upload. Throws when the file can't be cleaned. */
export function prepareMedia(bytes, name) {
  const mime = mimeOf(name);
  if (!mime) throw new Error('not a photo or video Sello supports');
  const b = Buffer.from(bytes);
  switch (mime) {
    case 'image/jpeg': return { bytes: stripJpeg(b), mime, kind: 'image' };
    case 'image/png': return { bytes: stripPng(b), mime, kind: 'image' };
    case 'image/webp': return { bytes: stripWebp(b), mime, kind: 'image' };
    case 'image/gif': return { bytes: b, mime, kind: 'image' };
    case 'image/heic': case 'image/heif': case 'image/avif':
      return { bytes: toJpeg(b, extname(name).toLowerCase()), mime: 'image/jpeg', kind: 'image' };
    case 'video/mp4': case 'video/quicktime': case 'video/3gpp': return { bytes: stripMp4(b), mime, kind: 'video' };
    default: return { bytes: b, mime, kind: kindOf(mime) };
  }
}
