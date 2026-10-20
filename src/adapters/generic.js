// Any app that exports a table: a JSON list or a CSV file with one row per entry. Columns are
// found by their usual names (date, created, title, body, text, content, tags, photos...); others
// can be named with --map, e.g. --map date=When,body=Notes,media=Attachments.
// Photo paths in the media column are relative to the file (several: separated by ; or |).
import { basename, dirname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { htmlToMarkdown } from '../markdown.js';

const FIELDS = {
  id: ['id', 'uuid', 'guid', 'key'],
  date: ['date', 'created', 'created_at', 'createdat', 'creationdate', 'creation_date', 'timestamp', 'datetime', 'time', 'fecha'],
  title: ['title', 'subject', 'heading', 'name', 'titulo', 'título'],
  body: ['body', 'text', 'content', 'note', 'notes', 'entry', 'markdown', 'html', 'texto', 'contenido'],
  tags: ['tags', 'labels', 'keywords', 'categories', 'etiquetas'],
  place: ['place', 'location', 'address', 'lugar'],
  media: ['media', 'photos', 'images', 'pictures', 'attachments', 'files', 'fotos'],
};

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  // The separator is whichever of , ; and tab the header line uses most.
  const first = text.slice(0, text.search(/\r?\n|$/));
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

function tableIn(src) {
  if (src.main) return /\.(json|csv)$/i.test(src.main) ? src.main : null;
  const files = src.names().filter((n) => /\.(json|csv)$/i.test(n));
  return files.length === 1 ? files[0] : null;
}

function rowsOf(src, name) {
  const text = src.read(name).toString('utf8').replace(/^﻿/, '');
  if (name.toLowerCase().endsWith('.csv')) return parseCsv(text);
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : Array.isArray(j.entries) ? j.entries : Array.isArray(j.items) ? j.items : Array.isArray(j.notes) ? j.notes : null;
  if (!list) throw new Error(`${name} is not a list of entries (or {"entries": [...]})`);
  return list;
}

export default {
  name: 'generic',
  description: 'A JSON list or CSV file with one row per entry (columns by name, or --map)',
  detect(src) {
    const t = tableIn(src);
    if (!t) return false;
    try { return rowsOf(src, t).length > 0; } catch { return false; }
  },
  *read(src, { map = {} } = {}) {
    const table = tableIn(src);
    if (!table) throw new Error('generic needs exactly one .json or .csv file');
    const rows = rowsOf(src, table);
    const keys = Object.keys(rows[0] ?? {});
    const pick = (field) => {
      if (map[field]) return keys.find((k) => k === map[field]) ?? keys.find((k) => k.toLowerCase() === map[field].toLowerCase()) ?? map[field];
      return keys.find((k) => FIELDS[field].includes(k.toLowerCase().replace(/\s+/g, '_')));
    };
    const col = Object.fromEntries(Object.keys(FIELDS).map((f) => [f, pick(f)]));
    if (!col.date) throw new Error(`no date column found among: ${keys.join(', ')}. Name it with --map date=<column>`);
    if (!col.body && !col.title) throw new Error(`no text column found among: ${keys.join(', ')}. Name it with --map body=<column>`);
    const names = new Set(src.names());
    const byBase = new Map(src.names().map((n) => [basename(n).toLowerCase(), n]));
    const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[;|]/)).map((x) => String(x).trim()).filter(Boolean);
    for (const r of rows) {
      let body = String(r[col.body] ?? '');
      if (/<\/?(p|div|br)\b/i.test(body)) body = htmlToMarkdown(body);
      const media = list(r[col.media]).map((p) => {
        const path = posix.normalize(posix.join(dirname(table), p.replace(/\\/g, '/')));
        return { name: names.has(path) ? path : byBase.get(basename(path).toLowerCase()) ?? p };
      });
      const id = r[col.id] ? String(r[col.id]) : createHash('sha256').update(`${r[col.date]}\n${r[col.title] ?? ''}\n${body}`).digest('hex').slice(0, 24);
      yield {
        id,
        date: r[col.date],
        title: String(r[col.title] ?? ''),
        body,
        tags: list(r[col.tags]).flatMap((t) => t.split(',')).map((t) => t.trim()),
        place: String(r[col.place] ?? ''),
        media,
      };
    }
  },
};
