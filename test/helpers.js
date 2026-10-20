// Test fixtures: tiny ZIPs, photos with metadata, and a fake Sello server with a fake phone.
import { createServer } from 'node:http';
import { crc32, deflateRawSync } from 'node:zlib';

export function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflateRawSync(data);
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, n, packed);
    central.push(cd, n);
    offset += 30 + n.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

/** A JPEG-shaped file with an EXIF block holding "GPS-SECRET". */
export function jpegWithExif() {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS-SECRET')]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(exif.length + 2, 2);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x07, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exif, app0, sos]);
}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

/**
 * A server that behaves like Sello for the routes the importer uses. Its phone approves every
 * sign-in on the second poll (after "scanning" on the first) and hands over [jk] the real way.
 */
// [refuse]: answers for the next photo uploads instead of taking them, e.g. {status: 429, retryAfter: 1, error}.
export async function fakeSello({ quota = 1e9, maxFile = 10 * 1048576, refuse = [] } = {}) {
  const jkRaw = crypto.getRandomValues(new Uint8Array(32));
  const jk = await subtle.importKey('raw', jkRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const requests = new Map();
  const posts = new Map();
  const media = new Map();
  const sessions = new Set();
  const user = { id: 'u1', username: 'tester' };
  let n = 0;

  async function sealJk(browserPub, requestId) {
    const pub = await subtle.importKey('spki', Buffer.from(browserPub, 'base64'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const wrap = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(requestId), info: enc.encode('sello-jk-transfer-v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, wrap, jkRaw);
    const b64 = (x) => Buffer.from(x).toString('base64');
    return { epk: b64(await subtle.exportKey('spki', eph.publicKey)), iv: b64(iv), ct: b64(ct) };
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const cookie = /sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
    const authed = cookie && sessions.has(cookie) && (req.method === 'GET' || req.headers['x-sello'] === '1');
    if (req.method === 'POST' && url.pathname === '/api/login-requests') {
      const b = JSON.parse(raw);
      const id = `req${++n}xxxxxxxxxxxx`;
      requests.set(id, { pub: b.browserPublicKey, polls: 0, secret: `s${n}`, ua: req.headers['user-agent'] });
      return send(200, { id, secret: `s${n}`, code: '47', expiresAt: Date.now() + 180000 });
    }
    const poll = url.pathname.match(/^\/api\/login-requests\/(\w+)\/poll$/);
    if (poll) {
      const r = requests.get(poll[1]);
      if (req.headers['x-sello-secret'] !== r.secret) return send(403, { error: 'forbidden' });
      r.polls++;
      if (r.polls === 1) return send(200, { status: 'pending', scanned: true });
      const sid = `sid${n}`;
      sessions.add(sid);
      return send(200, { status: 'approved', encryptedJK: await sealJk(r.pub, poll[1]), user }, { 'set-cookie': `sid=${sid}; HttpOnly; Path=/` });
    }
    if (!authed) return send(401, { error: 'unauthorized' });
    if (url.pathname === '/api/me') {
      const used = [...media.values()].reduce((s, m) => s + m.bytes.length, 0);
      return send(200, { user, storage: { used, quota, maxFile } });
    }
    if (url.pathname === '/api/posts' && url.searchParams.get('index')) return send(200, { index: [...posts.keys()].map((id) => [id, 1]) });
    if (req.method === 'POST' && url.pathname === '/api/media') {
      if (raw.length > maxFile + 64) return send(413, { error: 'too big' });
      const no = refuse.shift();
      if (no) return send(no.status, { error: no.error }, no.retryAfter ? { 'retry-after': String(no.retryAfter) } : {});
      const id = `m${++n}xxxxxxxxxxxxxxxx`;
      media.set(id, { bytes: raw, kind: url.searchParams.get('kind'), mime: url.searchParams.get('mime'), encrypted: url.searchParams.get('encrypted') });
      return send(200, { media: { id } });
    }
    const put = url.pathname.match(/^\/api\/posts\/([\w-]+)$/);
    if (req.method === 'PUT' && put) { posts.set(put[1], JSON.parse(raw)); return send(200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/logout') { sessions.delete(cookie); return send(200, { ok: true }); }
    send(404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const open = async (cipher) => {
    const c = JSON.parse(cipher);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(c.iv, 'base64') }, jk, Buffer.from(c.ct, 'base64'));
    return JSON.parse(new TextDecoder().decode(pt));
  };
  const openBytes = async (b) => Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, jk, b.subarray(12)));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    posts, media, sessions, requests, open, openBytes,
    close: () => new Promise((r) => server.close(r)),
  };
}
