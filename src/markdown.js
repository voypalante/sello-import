// Small text helpers shared by the adapters.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Lines of plain text that would read as Markdown syntax stay literal. */
function escapeLine(line) {
  return line.replace(/^(\s*)([#>*+-]|\d+\.)(\s)/, '$1\\$2$3');
}

/**
 * HTML from a rich text editor (paragraphs, line breaks, bold, italics, headings, lists, quotes,
 * links) as Markdown. Anything else keeps its text and loses its tags.
 */
export function htmlToMarkdown(html) {
  let s = String(html ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/\n/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n\u0000H${n}${t.trim()}\n\n`);
  s = s.replace(/<(b|strong)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, t) => (t.trim() ? `**${t.trim()}**` : t));
  s = s.replace(/<(i|em)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, t) => (t.trim() ? `*${t.trim()}*` : t));
  s = s.replace(/<(s|del|strike)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_, _t, _a, t) => (t.trim() ? `~~${t.trim()}~~` : t));
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => (/^https?:/i.test(href) ? `[${t}](${href})` : t));
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n\u0000LI${t.trim()}`);
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, t) => { let n = 0; return `\n\n${t.replace(/\u0000LI/g, () => `\u0000${++n}. `)}\n\n`; });
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n\n\u0000BQ${t}\u0000EQ\n\n`);
  s = s.replace(/<\/?(p|div|ul|section|article|header|footer)[^>]*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\u00a0/g, ' ');
  // Quotes, then plain lines that start like Markdown syntax but weren't meant as such.
  s = s.replace(/\u0000BQ([\s\S]*?)\u0000EQ/g, (_, t) => t.trim().split(/\n+/).map((l) => `\u0000BQ${escapeLine(l.trim())}`).join('\n'));
  s = s.split('\n').map((l) => escapeLine(l.replace(/[ \t]+/g, ' ').trim())).join('\n');
  // Markdown this function made itself, now that plain lines are escaped.
  s = s.replace(/\u0000H([1-6])/g, (_, n) => `${'#'.repeat(Number(n))} `).replace(/\u0000(\d+)\. /g, '$1. ').replace(/\u0000LI/g, '- ').replace(/\u0000BQ/g, '> ');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** A title from the first sentence or line of a body, for entries that have none. */
export function titleFrom(body, limit = 70) {
  const plain = String(body ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~`>\\]/g, '')
    .trim();
  const s = plain.split(/(?<=[.!?])\s|\n/, 1)[0].trim();
  if (s.length <= limit) return s.replace(/\.$/, '');
  return `${s.slice(0, limit).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
}
