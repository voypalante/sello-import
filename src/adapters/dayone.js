// Day One: Settings > Journals > (journal) > Export Journal > Export journal JSON file (a ZIP). One JSON per journal with every entry, and the
// files in photos/ and videos/ named by their MD5:
//   {"metadata": {"version": "1.0"}, "entries": [{"uuid": "…", "creationDate": "2020-09-13T12:26:40Z",
//    "text": "# Title\n\nText ![](dayone-moment://ABC)", "tags": [], "location": {"placeName": "…"},
//    "photos": [{"identifier": "ABC", "md5": "…", "type": "jpeg"}], "videos": […]}]}
import { basename } from 'node:path';

const isJournal = (j) => j && Array.isArray(j.entries) && (j.metadata || j.entries.some((e) => e.uuid && e.creationDate));

function parse(src, name) {
  try { return JSON.parse(src.read(name).toString('utf8')); } catch { return null; }
}

/** Day One escapes punctuation in its Markdown ("Hello\!"); Markdown readers don't need most of it. */
const unescape = (s) => s.replace(/\\([!.()\-+#[\]{}_*>`|~])/g, (m, c, i, all) => {
  // Keep the escape where it matters: at the start of a line ("\- not a list", "\# not a heading").
  const lineStart = i === 0 || all[i - 1] === '\n';
  return lineStart && /[-+#>*]/.test(c) ? m : c;
});

export default {
  name: 'dayone',
  description: 'Day One: the ZIP from Export > JSON (a journal JSON plus photos/ and videos/)',
  detect(src) {
    return src.names().some((n) => n.toLowerCase().endsWith('.json') && isJournal(parse(src, n)));
  },
  *read(src, options = {}) {
    const byStem = new Map();
    for (const n of src.names()) byStem.set(basename(n).replace(/\.[^.]+$/, '').toLowerCase(), n);
    for (const name of src.names()) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const journal = parse(src, name);
      if (!isJournal(journal)) continue;
      for (const e of journal.entries) {
        let body = unescape(String(e.text ?? '').replace(/\r\n?/g, '\n')).trim();
        let title = '';
        const first = body.match(/^#{1,6}\s+(.+)\n*/);
        if (first) { title = first[1].trim(); body = body.slice(first[0].length).trim(); }
        // Day One shows the first line as the title even without a heading, so it moves there
        // instead of being repeated above the text.
        else if (options.title !== false) {
          const line = body.match(/^([^\n]{1,120})\n+(?=\S)/);
          if (line && !line[1].includes('](')) { title = line[1].trim(); body = body.slice(line[0].length).trim(); }
        }
        const media = [];
        const attach = (list, scheme) => {
          for (const m of Array.isArray(list) ? list : []) {
            if (!m?.identifier) continue;
            const file = (m.md5 && byStem.get(String(m.md5).toLowerCase())) || `${scheme}s/${m.md5 ?? m.identifier}.${m.type ?? ''}`;
            for (const ref of [`dayone-moment://${m.identifier}`, `dayone-moment:/${scheme}/${m.identifier}`]) {
              if (body.includes(ref)) media.push({ name: file, ref });
            }
            if (!media.some((x) => x.name === file)) media.push({ name: file });
          }
        };
        attach(e.photos, 'photo');
        attach(e.videos, 'video');
        // Audio, PDFs and anything else Day One links to: Sello has no place for them.
        body = body.replace(/!?\[[^\]]*\]\(dayone-moment:\/(?:\/|audio\/|pdf\/)[^)]*\)/g, (m) => (media.some((x) => m.includes(x.ref)) ? m : ''));
        const loc = e.location ?? {};
        yield {
          id: String(e.uuid ?? e.creationDate),
          date: e.creationDate,
          title,
          body: body.replace(/\n{3,}/g, '\n\n'),
          tags: Array.isArray(e.tags) ? e.tags : [],
          place: loc.placeName || [loc.localityName, loc.country].filter(Boolean).join(', '),
          media,
        };
      }
    }
  },
};
