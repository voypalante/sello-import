// A folder (or ZIP) of Markdown or text files, one entry per file: Obsidian, Bear, Notion and
// most note apps export this way. The date comes from the front matter (date: / created:), else
// from the file name (2020-09-13 Sunday.md, 2020-09-13T12-26.md), else from the file's own date.
// The title comes from the front matter, else a first "# heading", else the file name.
// Pictures linked from a note, ![](photos/a.jpg) or Obsidian's ![[a.jpg]], come along.
import { basename, dirname, extname, posix } from 'node:path';
import { titleFrom } from '../markdown.js';

const TEXT = /\.(md|markdown|txt)$/i;

/** The few front matter shapes notes use: key: value, key: [a, b], and "- item" lists. */
export function frontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, rest: text };
  const data = {};
  let list = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item && list) { data[list].push(item[1].trim().replace(/^["']|["']$/g, '')); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const k = key.toLowerCase();
    const v = raw.trim();
    if (!v) { data[k] = []; list = k; continue; }
    list = null;
    data[k] = v.startsWith('[') && v.endsWith(']')
      ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : v.replace(/^["']|["']$/g, '');
  }
  return { data, rest: text.slice(m[0].length) };
}

export function dateFromName(name) {
  const m = basename(name).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T_](\d{2})[:.-]?(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h = '12', mi = '00'] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

const titleFromName = (name) => basename(name, extname(name))
  .replace(/(\d{4})-(\d{2})-(\d{2})(?:[ T_](\d{2})[:.-]?(\d{2}))?/, '')
  .replace(/[_-]+/g, ' ').trim();

export default {
  name: 'markdown',
  description: 'A folder or ZIP of Markdown or text files, one entry per file (Obsidian, Bear, Notion...)',
  detect(src) {
    return src.names().some((n) => TEXT.test(n));
  },
  *read(src) {
    const names = src.names();
    const byBase = new Map(names.map((n) => [basename(n).toLowerCase(), n]));
    const set = new Set(names);
    for (const name of names) {
      if (!TEXT.test(name)) continue;
      const { data, rest } = frontMatter(src.read(name).toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n'));
      let body = rest.trim();
      let title = typeof data.title === 'string' ? data.title : '';
      if (!title) {
        const h = body.match(/^#\s+(.+)\n*/);
        if (h) { title = h[1].trim(); body = body.slice(h[0].length).trim(); }
      }
      if (!title) title = titleFromName(name) || (name.toLowerCase().endsWith('.txt') ? titleFrom(body) : '');
      const media = [];
      const ref = (file) => { const r = `sello-src:${media.length}`; media.push({ name: file, ref: r }); return r; };
      // ![[a.jpg]] and ![[a.jpg|300]] (Obsidian) find the file anywhere in the export.
      body = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (m, target) => {
        const file = byBase.get(basename(target.trim()).toLowerCase());
        return file ? `![](${ref(file)})` : m;
      });
      // ![alt](relative/path.jpg) next to the note.
      body = body.replace(/!\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g, (m, alt, target) => {
        if (/^[a-z][\w+.-]*:/i.test(target)) return m;
        let path;
        try { path = posix.normalize(posix.join(dirname(name), decodeURI(target))); } catch { return m; }
        const file = set.has(path) ? path : byBase.get(basename(path).toLowerCase());
        return file ? `![${alt}](${ref(file)})` : m;
      });
      const date = data.date ?? data.created ?? data.created_at ?? data.creationdate ?? dateFromName(name) ?? src.mtime(name);
      const tags = Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? data.tags.split(/[,\s]+/) : [];
      yield {
        id: name,
        date,
        title,
        body,
        tags: tags.map((t) => String(t).replace(/^#/, '')),
        place: typeof data.location === 'string' ? data.location : typeof data.place === 'string' ? data.place : '',
        media,
      };
    }
  },
};
