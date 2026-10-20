import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { byName } from '../src/adapters/index.js';
import { writeEntries } from '../src/entries.js';
import { openSource } from '../src/source.js';
import { Sello } from '../src/sello.js';
import { selloId, upload } from '../src/upload.js';
import { fakeSello, jpegWithExif, zip } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'sello-import-up-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const quiet = { log: () => {}, out: { isTTY: false, write() {} } };
const fast = (server) => {
  const s = new Sello(server);
  const signIn = s.signIn.bind(s);
  s.signIn = (show) => signIn(show, { wait: () => Promise.resolve() });
  return s;
};

function converted() {
  const input = join(tmp, 'j.zip');
  writeFileSync(input, zip({
    'a.json': JSON.stringify({ id: 'a', date_journal: 1600000000000, type: 'html', text: '<p>First day.</p>', photos: ['a.jpg'], tags: ['x'], address: 'Home' }),
    'b.json': JSON.stringify({ id: 'b', date_journal: 1600086400000, type: 'markdown', text: 'Second day.' }),
    'a.jpg': jpegWithExif(),
  }));
  const src = openSource(input);
  const out = join(tmp, 'out');
  writeEntries(out, src, 'journey', byName('journey').read(src));
  src.close();
  return out;
}

test('signs in with the phone, encrypts and uploads, and a second run skips everything', async () => {
  const server = await fakeSello();
  try {
    const dir = converted();
    const shown = [];
    const r = await upload(dir, { server: server.url, client: fast(server.url), showLogin: (s) => shown.push(s), place: true, ...quiet });
    assert.equal(r.added, 2);
    assert.deepEqual(shown.map((s) => s.scanned), [false, true]);
    assert.match(shown[0].qr, /^sello:\/\/approve\/req\d+x+\?h=127\.0\.0\.1:\d+$/);
    assert.match([...server.requests.values()][0].ua, /^sello-import\/1\.0 \(/);

    const post = server.posts.get(selloId('u1', 'journey:a'));
    assert.equal(post.visibility, 'private');
    assert.equal(post.createdAt, 1600000000000);
    const plain = await server.open(post.cipher);
    const [mediaId] = server.media.keys();
    assert.deepEqual(plain, { title: 'First day', body: `First day.\n\n![](media/${mediaId})\n\n*Home*`, tags: ['x'] });

    const m = server.media.get(mediaId);
    assert.equal(m.encrypted, '1');
    assert.ok(!m.bytes.includes(Buffer.from('JFIF')), 'the server only sees ciphertext');
    const photo = await server.openBytes(m.bytes);
    assert.ok(photo.includes(Buffer.from('JFIF')) && !photo.includes(Buffer.from('GPS-SECRET')));
    assert.equal(server.sessions.size, 0, 'signed out at the end');
    assert.ok(existsSync(join(dir, '.sello-import-state.json')));

    const again = await upload(dir, { server: server.url, client: fast(server.url), showLogin: () => {}, ...quiet });
    assert.equal(again.added, 0);
    assert.equal(again.skipped, 2);
    assert.equal(server.media.size, 1);
  } finally {
    await server.close();
  }
});

test('dry run sends nothing; a full journal stops before uploading', async () => {
  const server = await fakeSello({ quota: 10 });
  try {
    const dir = converted();
    const dry = await upload(dir, { server: server.url, dryRun: true, ...quiet });
    assert.ok(dry.ok && dry.dryRun);
    assert.equal(server.requests.size, 0);
    await assert.rejects(upload(dir, { server: server.url, client: fast(server.url), showLogin: () => {}, ...quiet }), /MB free/);
    assert.equal(server.posts.size, 0);
    assert.equal(server.sessions.size, 0);
  } finally {
    await server.close();
  }
});

test('waits out a short "busy", and stops on a long wait so a later run goes on', async () => {
  const refuse = [{ status: 429, retryAfter: 1, error: 'Too many changes at once. Try again in a moment.' }];
  const server = await fakeSello({ refuse });
  try {
    const dir = converted();
    const r = await upload(dir, { server: server.url, client: fast(server.url), showLogin: () => {}, ...quiet });
    assert.equal(r.added, 2);
    assert.equal(server.media.size, 1);
  } finally {
    await server.close();
  }

  const later = await fakeSello({ refuse: [{ status: 429, retryAfter: 3600, error: 'Many new journals are uploading right now.' }] });
  try {
    rmSync(join(tmp, 'out'), { recursive: true, force: true });
    const dir = converted();
    const lines = [];
    const first = await upload(dir, { server: later.url, client: fast(later.url), showLogin: () => {}, ...quiet, log: (l) => lines.push(l) });
    assert.equal(first.added, 0);
    assert.ok(lines.some((l) => l.startsWith('Stopping: Many new journals')));
    assert.ok(lines.some((l) => l.includes('goes on where it left off')));
    const again = await upload(dir, { server: later.url, client: fast(later.url), showLogin: () => {}, ...quiet });
    assert.equal(again.added, 2);
  } finally {
    await later.close();
  }
});
