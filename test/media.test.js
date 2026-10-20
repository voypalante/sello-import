import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareMedia, stripMp4, stripPng, stripWebp } from '../src/media.js';
import { jpegWithExif } from './helpers.js';

const has = (buf, s) => buf.includes(Buffer.from(s));

test('JPEG loses its EXIF block and keeps the image data', () => {
  const { bytes, mime } = prepareMedia(jpegWithExif(), 'a.JPG');
  assert.equal(mime, 'image/jpeg');
  assert.ok(!has(bytes, 'GPS-SECRET'));
  assert.ok(has(bytes, 'JFIF'));
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
});

test('PNG loses eXIf and text chunks', () => {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', Buffer.alloc(13)), chunk('eXIf', Buffer.from('GPS-SECRET')), chunk('tEXt', Buffer.from('where')), chunk('IDAT', Buffer.from('x')), chunk('IEND', Buffer.alloc(0))]);
  const out = stripPng(png);
  assert.ok(!has(out, 'GPS-SECRET') && !has(out, 'where'));
  assert.ok(has(out, 'IHDR') && has(out, 'IDAT') && has(out, 'IEND'));
});

test('WebP loses EXIF and its flag', () => {
  const chunk = (type, data) => { const b = Buffer.alloc(8 + data.length + (data.length & 1)); b.write(type, 0, 'latin1'); b.writeUInt32LE(data.length, 4); data.copy(b, 8); return b; };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08;
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8 ', Buffer.from('img')), chunk('EXIF', Buffer.from('GPS-SECRET'))]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  const out = stripWebp(Buffer.concat([head, body]));
  assert.ok(!has(out, 'GPS-SECRET'));
  assert.equal(out[20] & 0x08, 0);
  assert.equal(out.readUInt32LE(4), out.length - 8);
});

test('MP4 metadata boxes are blanked in place', () => {
  const box = (type, data) => { const b = Buffer.alloc(8 + data.length); b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.concat([box('mvhd', Buffer.alloc(4)), box('udta', box('©xyz', Buffer.from('+08.9-079.5/')))]))]);
  const out = stripMp4(mp4);
  assert.equal(out.length, mp4.length);
  assert.ok(!has(out, '+08.9') && has(out, 'free') && has(out, 'mvhd'));
});

test('unsupported files are refused', () => {
  assert.throws(() => prepareMedia(Buffer.from('x'), 'a.pdf'), /not a photo or video/);
});
