// Journey (journey.cloud): Settings > Export, "ZIP" (JSON). One JSON file per entry, photos next to them.
//   {"id": "...", "date_journal": 1600000000000, "timezone": "America/Panama", "text": "<p>…</p>",
//    "type": "html", "photos": ["….jpg"], "tags": ["…"], "address": "…", …}
import { basename } from 'node:path';
import { htmlToMarkdown } from '../markdown.js';

const isEntry = (j) => j && typeof j === 'object' && 'date_journal' in j && ('text' in j || 'photos' in j);

function parse(src, name) {
  try { return JSON.parse(src.read(name).toString('utf8')); } catch { return null; }
}

export default {
  name: 'journey',
  description: 'Journey (journey.cloud): the ZIP from Export, with one JSON file per entry',
  detect(src) {
    const json = src.names().filter((n) => n.toLowerCase().endsWith('.json'));
    return json.length > 0 && json.slice(0, 3).some((n) => isEntry(parse(src, n)));
  },
  *read(src) {
    const byBase = new Map(src.names().map((n) => [basename(n), n]));
    for (const name of src.names()) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const j = parse(src, name);
      if (!isEntry(j)) continue;
      const text = String(j.text ?? '');
      const html = j.type === 'html' || /<\/?(p|div|br|span|b|i|ul|ol|li)\b/i.test(text);
      yield {
        id: String(j.id ?? basename(name, '.json')),
        date: Number(j.date_journal),
        title: '',
        body: html ? htmlToMarkdown(text) : text,
        tags: Array.isArray(j.tags) ? j.tags : [],
        place: typeof j.address === 'string' ? j.address : '',
        media: (Array.isArray(j.photos) ? j.photos : []).map((p) => ({ name: byBase.get(basename(String(p))) ?? String(p) })),
      };
    }
  },
};
