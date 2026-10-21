// The format every adapter converts to: a folder with entries.json and the photos and videos in
// files/. It is plain JSON on purpose, so it can be checked, edited by hand, or written by any
// other tool before uploading.
//
//   {
//     "format": "sello-import/1",
//     "source": "journey",
//     "entries": [{
//       "id": "journey:1600000000000-abc",   unique and stable: the same entry always gets the same id
//       "date": "2020-09-13T12:26:40.000Z",  when it was written (ISO 8601)
//       "title": "Sunday at the beach",
//       "body": "Markdown. ![](files/1-photo.jpg) puts a photo here.",
//       "tags": ["family"],
//       "place": "Panamá",                    optional
//       "files": ["files/1-photo.jpg"]        every file the entry has, in order
//     }]
//   }
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { titleFrom } from './markdown.js';
import { isMedia } from './media.js';

export const FORMAT = 'sello-import/1';

export function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return toDate(Number(s));
    // "2020-09-13 12:26" (no zone) is read as local time, like the date it was written on.
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') : s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const safeName = (n) => basename(n).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+/, '').slice(-80) || 'file';

/**
 * Writes what an adapter read into [outDir]. Each item: {id, date, title, body, tags, place,
 * media: [{name, ref}], skip}, where name is the file's path in the export and ref (optional) is the text
 * in body that stands for it; ref is replaced with the copied file's path, and media without a ref
 * go at the end of the entry. An item with skip (the reason) is left out with a warning.
 */
export function writeEntries(outDir, src, sourceName, items, { autoTitle = true } = {}) {
  mkdirSync(join(outDir, 'files'), { recursive: true });
  const names = new Set(src.names());
  const copied = new Map();
  const warnings = [];
  const entries = [];
  const ids = new Set();
  let n = 0;
  for (const item of items) {
    const label = item.title || item.id;
    const date = toDate(item.date);
    if (!date) { warnings.push(`skipped "${label}": no date`); continue; }
    if (item.skip) { warnings.push(`skipped an entry from ${date.toISOString().slice(0, 10)}: ${item.skip}`); continue; }
    const id = `${sourceName}:${item.id}`;
    if (ids.has(id)) { warnings.push(`skipped a second entry with id ${item.id}`); continue; }
    ids.add(id);
    let body = String(item.body ?? '').trim();
    const files = [];
    const tail = [];
    for (const m of item.media ?? []) {
      if (!m.name || !names.has(m.name)) {
        warnings.push(`${date.toISOString().slice(0, 10)} "${label}": ${m.name ?? m.ref} is not in the export`);
        if (m.ref) {
          const ref = m.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          body = body.replace(new RegExp(`!?\\[[^\\]]*\\]\\(${ref}\\)`, 'g'), '').split(m.ref).join('');
        }
        continue;
      }
      if (!isMedia(m.name)) { warnings.push(`${date.toISOString().slice(0, 10)} "${label}": ${m.name} is not a photo or video, left out`); continue; }
      let file = copied.get(m.name);
      if (!file) {
        file = `files/${++n}-${safeName(m.name)}`;
        writeFileSync(join(outDir, file), src.read(m.name));
        copied.set(m.name, file);
      }
      if (!files.includes(file)) files.push(file);
      if (m.ref && body.includes(m.ref)) body = body.split(m.ref).join(file);
      else if (!body.includes(`(${file})`)) tail.push(`![](${file})`);
    }
    if (tail.length) body = [body, ...tail].filter(Boolean).join('\n\n');
    body = body.replace(/\n{3,}/g, '\n\n').trim();
    const title = String(item.title ?? '').trim() || (autoTitle ? titleFrom(body) : '');
    if (!title && !body) { warnings.push(`skipped an empty entry from ${date.toISOString().slice(0, 10)}`); continue; }
    const tags = [...new Set((item.tags ?? []).map((t) => String(t).trim()).filter(Boolean))];
    const entry = { id, date: date.toISOString(), title, body, tags, files };
    if (item.place) entry.place = String(item.place).trim();
    entries.push(entry);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(join(outDir, 'entries.json'), `${JSON.stringify({ format: FORMAT, source: sourceName, entries }, null, 1)}\n`);
  return { entries, files: copied.size, warnings };
}

/** Reads and checks entries.json; problems come back as a list so a dry run can show them all. */
export function readEntries(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.format !== FORMAT) throw new Error(`${path} is not a sello-import file (format "${data.format}")`);
  const problems = [];
  const ids = new Set();
  for (const [i, e] of (data.entries ?? []).entries()) {
    const where = `entry ${i + 1}${e.title ? ` "${e.title}"` : ''}`;
    if (typeof e.id !== 'string' || !e.id) problems.push(`${where}: no id`);
    else if (ids.has(e.id)) problems.push(`${where}: id ${e.id} is used twice`);
    ids.add(e.id);
    if (!toDate(e.date)) problems.push(`${where}: no valid date`);
    if (typeof e.body !== 'string' && typeof e.title !== 'string') problems.push(`${where}: no title or body`);
    if (e.files && !Array.isArray(e.files)) problems.push(`${where}: files must be a list`);
  }
  return { entries: data.entries ?? [], source: data.source, problems };
}
