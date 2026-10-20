// Uploads a converted folder (entries.json + files/) into a Sello journal, as private entries that
// keep their dates. Runs can be repeated: entries already in the journal are skipped, and files
// already uploaded are remembered in .sello-import-state.json, so an interrupted import resumes.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEntries, toDate } from './entries.js';
import { prepareMedia } from './media.js';
import { Sello } from './sello.js';

const mb = (n) => (n / 1048576).toFixed(1);
const STATE = '.sello-import-state.json';

/** The Sello id for an entry: the same journal and source entry always give the same id. */
export const selloId = (userId, entryId) => createHash('sha256').update(`sello-import:${userId}:${entryId}`).digest('base64url').slice(0, 22);

/** Body with files/… links pointing at the uploaded files, and the place as a last line if asked. */
export function finalBody(entry, uploaded, { place = false } = {}) {
  let body = String(entry.body ?? '');
  for (const [file, id] of uploaded) body = body.split(`](${file})`).join(`](media/${id})`);
  if (place && entry.place) body = `${body}\n\n*${entry.place}*`;
  return body.trim();
}

function progress(out, total) {
  const started = Date.now();
  let done = 0;
  const tty = out.isTTY;
  return {
    add(n) { done += n; },
    draw(i, n, note = '') {
      if (!tty) return;
      const pct = total ? Math.min(1, done / total) : i / n;
      const fill = Math.round(pct * 28);
      const secs = (Date.now() - started) / 1000;
      const eta = pct > 0.02 && pct < 1 ? Math.round(secs / pct - secs) : null;
      const etaText = eta == null ? '' : ` · ${eta >= 60 ? `${Math.floor(eta / 60)}m${String(eta % 60).padStart(2, '0')}s` : `${eta}s`} left`;
      out.write(`\r[${'█'.repeat(fill)}${'░'.repeat(28 - fill)}] ${String(Math.floor(pct * 100)).padStart(3)}%  ${i}/${n} entries  ${mb(done)}/${mb(total)} MB${etaText}${note ? `  ${note}` : ''}`.padEnd(110));
    },
    end() { if (tty) out.write('\n'); },
  };
}

export async function upload(dir, { server, dryRun = false, limit = Infinity, place = false, log = console.log, out = process.stdout, showLogin, client } = {}) {
  const file = join(dir, 'entries.json');
  if (!existsSync(file)) throw new Error(`${file} not found. Run "sello-import convert" first.`);
  const { entries: all, source, problems } = readEntries(file);
  const entries = all.slice(0, limit);

  // Every file is prepared once up front: it proves each one can be cleaned of its metadata, and
  // gives the real sizes for the quota check.
  const sizes = new Map();
  for (const e of entries) {
    for (const f of e.files ?? []) {
      if (sizes.has(f)) continue;
      const path = join(dir, f);
      if (!existsSync(path)) { problems.push(`"${e.title}": ${f} is missing`); continue; }
      try { sizes.set(f, prepareMedia(readFileSync(path), f).bytes.length); } catch (err) { problems.push(`"${e.title}": ${f}: ${err.message}`); }
    }
  }
  const textBytes = (e) => Buffer.byteLength(e.title ?? '') + Buffer.byteLength(e.body ?? '');
  const total = entries.reduce((s, e) => s + textBytes(e), 0) + [...sizes.values()].reduce((s, n) => s + n, 0);
  const dates = entries.map((e) => toDate(e.date)).filter(Boolean).sort((a, b) => a - b);

  log(`${source ?? 'entries'} → Sello (${server})`);
  log(`  ${entries.length} entries${dates.length ? `, ${dates[0].toISOString().slice(0, 10)} to ${dates.at(-1).toISOString().slice(0, 10)}` : ''}`);
  log(`  ${sizes.size} ${sizes.size === 1 ? "photo or video" : "photos and videos"}, ${mb(total)} MB in all`);
  log('  all private, encrypted here before they are sent');
  const big = [...sizes].filter(([, n]) => n > 10 * 1048576);
  if (big.length) log(`  ${big.length} file(s) over 10 MB; Sello's usual limit per file is 10 MB, so they may be left out`);
  if (problems.length) {
    log(`\n${problems.length} problem(s), fix them before uploading:\n  ${problems.join('\n  ')}`);
    return { ok: false, problems };
  }
  if (dryRun) {
    log('\nDry run: everything checks out and nothing was sent. Run again without --dry-run with your phone at hand.');
    return { ok: true, dryRun: true };
  }

  const sello = client ?? new Sello(server);
  const user = await sello.signIn(showLogin);
  log(`\nSigned in as @${user.username}. Importing…\n`);
  const statePath = join(dir, STATE);
  const key = `${sello.server} ${user.id}`;
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  const remembered = new Map(Object.entries(state[key] ?? {}));
  const remember = (f, id) => {
    remembered.set(f, id);
    state[key] = Object.fromEntries(remembered);
    writeFileSync(statePath, JSON.stringify(state, null, 1));
  };

  let added = 0, skipped = 0;
  const failed = [];
  const leftOut = [];
  const bar = progress(out, total);
  try {
    const { storage } = await sello.me();
    const room = storage ? storage.quota - storage.used : Infinity;
    if (total > room) throw new Error(`The import is ${mb(total)} MB and the journal has ${mb(Math.max(0, room))} MB free.`);
    const existing = await sello.entryIds();
    for (const [i, e] of entries.entries()) {
      const id = selloId(user.id, e.id);
      const size = textBytes(e) + (e.files ?? []).reduce((s, f) => s + (sizes.get(f) ?? 0), 0);
      if (existing.has(id)) { skipped++; bar.add(size); bar.draw(i + 1, entries.length); continue; }
      const label = `${String(e.date).slice(0, 10)} "${e.title}"`;
      try {
        const uploaded = new Map();
        for (const f of e.files ?? []) {
          let mediaId = remembered.get(f);
          if (!mediaId) {
            const prepared = prepareMedia(readFileSync(join(dir, f)), f);
            if (storage?.maxFile && prepared.bytes.length > storage.maxFile) {
              leftOut.push(`${label}: ${f} is ${mb(prepared.bytes.length)} MB, over the ${mb(storage.maxFile)} MB limit`);
              bar.add(sizes.get(f) ?? 0);
              continue;
            }
            bar.draw(i, entries.length, `uploading ${String(e.date).slice(0, 10)}`);
            mediaId = await retry(() => sello.uploadFile(prepared.bytes, prepared.kind, prepared.mime));
            remember(f, mediaId);
          }
          uploaded.set(f, mediaId);
          bar.add(sizes.get(f) ?? 0);
        }
        const body = finalBody(e, uploaded, { place });
        await retry(() => sello.savePrivate(id, { title: e.title ?? '', body, tags: e.tags ?? [] }, toDate(e.date).getTime()));
        bar.add(textBytes(e));
        added++;
      } catch (err) {
        failed.push(`${label}: ${err.message}`);
        if ([401, 403, 413, 423].includes(err.status)) { bar.end(); log(`Stopping: ${err.message}`); break; }
      }
      bar.draw(i + 1, entries.length);
    }
  } finally {
    bar.end();
    await sello.signOut();
  }
  log(`\nDone: ${added} imported, ${skipped} already there, ${failed.length} failed. Signed out.`);
  if (leftOut.length) log(`Left out (too big):\n  ${leftOut.join('\n  ')}`);
  if (failed.length) log(`Failed (run it again to retry them):\n  ${failed.join('\n  ')}`);
  if (!failed.length) log(`\nWhen you've checked your journal, delete the plain copies: sello-import cleanup ${dir}`);
  return { ok: failed.length === 0, added, skipped, failed, leftOut };
}

async function retry(fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 3 || (err.status >= 400 && err.status < 500)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** True when [dir] looks like a folder this tool wrote (so cleanup never deletes anything else). */
export function isImportFolder(dir) {
  try {
    return statSync(dir).isDirectory() && JSON.parse(readFileSync(join(dir, 'entries.json'), 'utf8')).format?.startsWith('sello-import/');
  } catch {
    return false;
  }
}
