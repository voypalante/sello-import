// A Sello client for Node, signing in the way the web app does: this program makes a one-time key
// pair and shows a QR code; the Sello app on the phone scans it, the person compares the number
// and approves with their fingerprint, and the phone sends the journal key encrypted to that key
// pair (P-256 ECDH + HKDF-SHA256, AES-GCM). Entries and files are encrypted here with the journal
// key before they're sent, exactly like the web app does, so the server only stores ciphertext.
import { platform } from 'node:os';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

const OS = { linux: 'Linux', darwin: 'Mac OS X', win32: 'Windows' }[platform()] ?? platform();
export const USER_AGENT = `sello-import/1.0 (${OS})`;

export class SelloError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function newKeyPair() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: b64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey))) };
}

/** The journal key from the phone's {epk, iv, ct}, as a key whose bytes JavaScript never sees. */
export async function openJournalKey(privateKey, sealed, requestId) {
  const epk = await subtle.importKey('spki', unb64(sealed.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(requestId), info: enc.encode('sello-jk-transfer-v1') },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey'],
  );
  return subtle.unwrapKey('raw', unb64(sealed.ct), wrapKey, { name: 'AES-GCM', iv: unb64(sealed.iv) },
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** {title, body, tags} as the cipher text Sello stores for a private entry. */
export async function sealEntry(jk, entry) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, jk, enc.encode(JSON.stringify(entry))));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

/** Files are stored as iv (12 bytes) followed by the ciphertext and tag. */
export async function sealBytes(jk, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, jk, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export class Sello {
  constructor(server) {
    this.server = server.replace(/\/+$/, '');
    this.cookie = null;
    this.jk = null;
    this.user = null;
  }

  async request(path, { method = 'GET', json, body, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(`${this.server}${path}`, {
        method,
        headers: {
          'user-agent': USER_AGENT,
          'x-sello': '1',
          ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: json !== undefined ? JSON.stringify(json) : body,
      });
    } catch (err) {
      throw new SelloError(0, `can't reach ${this.server} (${err.cause?.code ?? err.message})`);
    }
    for (const c of res.headers.getSetCookie?.() ?? []) this.cookie = c.split(';')[0];
    const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
    if (!res.ok) throw new SelloError(res.status, data?.error ?? `${method} ${path} failed (${res.status})`);
    return data;
  }

  /**
   * Signs in. [show] gets {qr, code, scanned} to draw: first the QR code to scan, then (scanned)
   * the number to compare on the phone. A request lasts a few minutes; a new one replaces it.
   */
  async signIn(show, { attempts = 10, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const host = new URL(this.server).host;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const keys = await newKeyPair();
      const req = await this.request('/api/login-requests', { method: 'POST', json: { purpose: 'login', browserPublicKey: keys.publicKey } });
      const qr = `sello://approve/${req.id}?h=${host}`;
      show({ qr, code: req.code, scanned: false, attempt, attempts });
      let scanned = false;
      for (;;) {
        await wait(1500);
        let r;
        try {
          r = await this.request(`/api/login-requests/${req.id}/poll`, { headers: { 'x-sello-secret': req.secret } });
        } catch (err) {
          if (err.status === 429 || err.status === 0) continue;
          throw err;
        }
        if (r.scanned && !scanned) { scanned = true; show({ qr, code: req.code, scanned: true, attempt, attempts }); }
        if (r.status === 'denied') throw new SelloError(403, 'The request was declined on the phone.');
        if (r.status === 'expired') break;
        if (r.status === 'approved') {
          this.jk = await openJournalKey(keys.privateKey, r.encryptedJK, req.id);
          this.user = r.user;
          return r.user;
        }
      }
    }
    throw new SelloError(408, 'Nobody approved the sign-in.');
  }

  me() { return this.request('/api/me'); }

  /** Ids of every entry already in the journal. */
  async entryIds() {
    const { index } = await this.request('/api/posts?index=1');
    return new Set(index.map(([id]) => id));
  }

  async uploadFile(bytes, kind, mime) {
    const sealed = await sealBytes(this.jk, bytes);
    const { media } = await this.request(`/api/media?kind=${kind}&mime=${encodeURIComponent(mime)}&encrypted=1`, {
      method: 'POST', body: sealed, headers: { 'content-type': 'application/octet-stream' },
    });
    return media.id;
  }

  async savePrivate(id, { title, body, tags }, createdAt) {
    const cipher = await sealEntry(this.jk, { title, body, tags });
    await this.request(`/api/posts/${id}`, { method: 'PUT', json: { visibility: 'private', cipher, createdAt } });
  }

  async signOut() {
    if (this.cookie) await this.request('/api/logout', { method: 'POST' }).catch(() => {});
    this.cookie = null;
    this.jk = null;
  }
}
