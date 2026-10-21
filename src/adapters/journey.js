// Journey (journey.cloud), from Settings > Data > Cloud Accounts. Two ZIPs, both one JSON file per entry:
//  - a Google account's "Export" (ZIP): every file at the top, photos listed in the entry:
//      {"id": "...", "date_journal": 1600000000000, "timezone": "America/Panama", "text": "<p>…</p>",
//       "type": "html", "photos": ["….jpg"], "tags": ["…"], "address": "…", …}
//  - a Journey Drive account's "Backup": a folder per entry, named by its id, with the entry's photos:
//      <id>/<id>.json {"id": "...", "dateOfJournal": "2020-09-13T12:26:40.000Z", "text": "<p>…</p>",
//                      "type": "html", "tags": [], "address": "…", "encrypted": false, "schemaVersion": 2, …}
//      <id>/<photo id>.jpg
import { basename, dirname } from 'node:path';
import { htmlToMarkdown } from '../markdown.js';

const isEntry = (j) => j && typeof j === 'object' && ('date_journal' in j || 'dateOfJournal' in j) && ('text' in j || 'photos' in j);

function parse(src, name) {
  try { return JSON.parse(src.read(name).toString('utf8')); } catch { return null; }
}

export default {
  name: 'journey',
  description: 'Journey (journey.cloud): the ZIP from Export (Google account) or Backup (Journey Drive)',
  detect(src) {
    const json = src.names().filter((n) => n.toLowerCase().endsWith('.json'));
    return json.length > 0 && json.slice(0, 3).some((n) => isEntry(parse(src, n)));
  },
  *read(src) {
    const byBase = new Map(src.names().map((n) => [basename(n), n]));
    const byDir = new Map();
    for (const n of src.names()) {
      if (n.endsWith('/') || n.toLowerCase().endsWith('.json')) continue;
      byDir.set(dirname(n), [...(byDir.get(dirname(n)) ?? []), n]);
    }
    for (const name of src.names()) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const j = parse(src, name);
      if (!isEntry(j)) continue;
      const id = String(j.id ?? basename(name, '.json'));
      if (j.encrypted === true) { yield { id, date: j.dateOfJournal ?? Number(j.date_journal), skip: 'encrypted in Journey' }; continue; }
      const text = String(j.text ?? '');
      const html = j.type === 'html' || /<\/?(p|div|br|span|b|i|ul|ol|li)\b/i.test(text);
      // A backup has no photo list: the entry's photos are the other files in its folder.
      const photos = Array.isArray(j.photos)
        ? j.photos.map((p) => byBase.get(basename(String(p))) ?? String(p))
        : basename(dirname(name)) === id ? (byDir.get(dirname(name)) ?? []).sort() : [];
      yield {
        id,
        date: 'dateOfJournal' in j ? j.dateOfJournal : Number(j.date_journal),
        title: '',
        body: html ? htmlToMarkdown(text) : text,
        tags: Array.isArray(j.tags) ? j.tags : [],
        place: typeof j.address === 'string' ? j.address : '',
        media: photos.map((name) => ({ name })),
      };
    }
  },
};
