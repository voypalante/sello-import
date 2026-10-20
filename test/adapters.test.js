import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { byName, detect } from '../src/adapters/index.js';
import { parseCsv } from '../src/adapters/generic.js';
import { writeEntries } from '../src/entries.js';
import { openSource } from '../src/source.js';
import { jpegWithExif, zip } from './helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'sello-import-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let k = 0;
const file = (name, content) => { const p = join(tmp, `${++k}-${name}`); writeFileSync(p, content); return p; };
function convert(input, from) {
  const src = openSource(input);
  const adapter = from ? byName(from) : detect(src);
  const out = join(tmp, `out${++k}`);
  const r = writeEntries(out, src, adapter.name, adapter.read(src, {}));
  src.close();
  return { adapter: adapter.name, out, ...r, json: JSON.parse(readFileSync(join(out, 'entries.json'), 'utf8')) };
}

test('Journey ZIP: HTML text, date, tags, place, photo', () => {
  const input = file('journey.zip', zip({
    'export/1600000000000-abc.json': JSON.stringify({
      id: '1600000000000-abc', date_journal: 1600000000000, timezone: 'America/Panama', type: 'html',
      text: '<p>Sunday at the <b>beach</b>.</p><p>- not a list</p><ul><li>sun</li><li>sea</li></ul>',
      photos: ['1600000000000-abc-photo.jpg'], tags: ['family'], address: 'Playa Blanca', lat: 1.7976931348623157e308,
    }),
    'export/1600000000000-abc-photo.jpg': jpegWithExif(),
  }));
  const r = convert(input);
  assert.equal(r.adapter, 'journey');
  const [e] = r.entries;
  assert.equal(e.id, 'journey:1600000000000-abc');
  assert.equal(e.date, new Date(1600000000000).toISOString());
  assert.equal(e.title, 'Sunday at the beach');
  assert.match(e.body, /^Sunday at the \*\*beach\*\*\.\n\n\\- not a list\n\n- sun\n- sea\n\n!\[\]\(files\/1-1600000000000-abc-photo\.jpg\)$/);
  assert.deepEqual(e.tags, ['family']);
  assert.equal(e.place, 'Playa Blanca');
  assert.deepEqual(e.files, ['files/1-1600000000000-abc-photo.jpg']);
  assert.deepEqual(readFileSync(join(r.out, e.files[0])), jpegWithExif());
});

test('Day One ZIP: title from heading, inline photo, missing video, unescaping', () => {
  const input = file('dayone.zip', zip({
    'Journal.json': JSON.stringify({
      metadata: { version: '1.0' },
      entries: [{
        uuid: 'ABC123', creationDate: '2021-03-04T05:06:07Z', tags: ['trip'], location: { localityName: 'Boquete', country: 'Panamá' },
        text: '# Weekend in Boquete\n\nCold mornings\\. Strong coffee\\!\n\n![](dayone-moment://P1)\n\n\\- literal\n\n![](dayone-moment:/video/V1)',
        photos: [{ identifier: 'P1', md5: 'aaa111', type: 'jpeg' }],
        videos: [{ identifier: 'V1', md5: 'bbb222', type: 'mov' }],
      }],
    }),
    'photos/aaa111.jpeg': jpegWithExif(),
  }));
  const r = convert(input);
  assert.equal(r.adapter, 'dayone');
  const [e] = r.entries;
  assert.equal(e.title, 'Weekend in Boquete');
  assert.equal(e.body, 'Cold mornings. Strong coffee!\n\n![](files/1-aaa111.jpeg)\n\n\\- literal');
  assert.equal(e.place, 'Boquete, Panamá');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /videos\/bbb222\.mov is not in the export/);
});

test('Markdown folder: front matter, dates from names, Obsidian and relative pictures', () => {
  const dir = join(tmp, 'notes');
  mkdirSync(join(dir, 'daily'), { recursive: true });
  mkdirSync(join(dir, 'attachments'));
  writeFileSync(join(dir, 'attachments', 'a.jpg'), jpegWithExif());
  writeFileSync(join(dir, 'attachments', 'b one.jpg'), jpegWithExif());
  writeFileSync(join(dir, 'daily', '2022-05-06 Market day.md'), 'Bought ñame.\n\n![[a.jpg|300]]\n\n![b](../attachments/b%20one.jpg)\n');
  writeFileSync(join(dir, 'daily', 'thoughts.md'), '---\ntitle: "Quiet night"\ndate: 2022-05-07T21:00:00-05:00\ntags:\n  - home\n  - "#calm"\n---\n# Ignored? no, kept\nText');
  writeFileSync(join(dir, 'daily', '2022-05-08.txt'), 'Plain text day. More.');
  const r = convert(dir);
  assert.equal(r.adapter, 'markdown');
  const [a, b, c] = r.entries;
  assert.equal(a.title, 'Market day');
  assert.equal(a.date, new Date('2022-05-06T12:00:00').toISOString());
  assert.equal(a.body, 'Bought ñame.\n\n![](files/1-a.jpg)\n\n![b](files/2-b-one.jpg)');
  assert.equal(b.title, 'Quiet night');
  assert.equal(b.date, '2022-05-08T02:00:00.000Z');
  assert.deepEqual(b.tags, ['home', 'calm']);
  assert.equal(b.body, '# Ignored? no, kept\nText');
  assert.equal(c.title, 'Plain text day');
});

test('generic CSV and JSON, with --map', () => {
  const csv = file('diary.csv', 'When;Notes;Labels\n2020-01-02 08:30;"Line one\nline ""two""";a, b\n');
  const src = openSource(csv);
  const entries = [...byName('generic').read(src, { map: { date: 'When', body: 'Notes', tags: 'Labels' } })];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, 'Line one\nline "two"');
  assert.deepEqual(entries[0].tags, ['a', 'b']);

  const json = file('notes.json', JSON.stringify({ entries: [{ id: 7, created_at: 1577836800, title: 'New year', content: '<p>Hi</p>' }] }));
  const r = convert(json);
  assert.equal(r.adapter, 'generic');
  assert.equal(r.entries[0].id, 'generic:7');
  assert.equal(r.entries[0].date, '2020-01-01T00:00:00.000Z');
  assert.equal(r.entries[0].body, 'Hi');
});

test('CSV parser handles commas, quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y",2\r\n'), [{ a: 'x, y', b: '2' }]);
});
