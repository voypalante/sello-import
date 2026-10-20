#!/usr/bin/env node
// sello-import: bring a journal from another app into Sello.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { adapters, byName, detect } from '../src/adapters/index.js';
import { writeEntries } from '../src/entries.js';
import { openSource } from '../src/source.js';
import { isImportFolder, upload } from '../src/upload.js';

const HELP = `sello-import: bring a journal from another app into Sello

  sello-import convert <export> [--from <app>] [--out <folder>] [--map field=column,...] [--no-title]
      Reads an export (ZIP, folder or file) and writes <folder>/entries.json and <folder>/files/.
      The app is detected; --from picks it. Check entries.json before uploading if you like.

  sello-import upload <folder> [--server <url>] [--dry-run] [--limit <n>] [--place]
      Signs in with a QR code you scan with the Sello app, then uploads every entry as private,
      encrypted on this computer first. Safe to run again: what's already there is skipped.
      --place adds where an entry was written as its last line.

  sello-import cleanup <folder> [--yes]
      Deletes the converted folder, which holds your journal unencrypted.

  sello-import apps
      Lists the apps it can read.

Server: ${'https://sello.voypalante.com'} unless --server or SELLO_SERVER says otherwise.
`;

const { values: o, positionals: [command, target] } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    out: { type: 'string' },
    map: { type: 'string', multiple: true },
    'no-title': { type: 'boolean' },
    server: { type: 'string' },
    'dry-run': { type: 'boolean' },
    limit: { type: 'string' },
    place: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
});

const fail = (msg) => { console.error(`sello-import: ${msg}`); process.exit(1); };

async function showLogin({ qr, code, scanned, attempt, attempts }) {
  if (scanned) {
    console.log(`\nScanned. On your phone, tap the number ${code} and approve with your fingerprint.`);
    return;
  }
  const QRCode = (await import('qrcode')).default;
  console.log(`\nOpen Sello on your phone, tap the laptop icon at the top and scan this code${attempt > 1 ? ` (new code, ${attempt}/${attempts})` : ''}:\n`);
  console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
  console.log(`The phone will show the number ${code}. Only approve if it matches.`);
}

if (o.help || !command) { console.log(HELP); process.exit(0); }

if (command === 'apps') {
  for (const a of adapters) console.log(`  ${a.name.padEnd(10)} ${a.description}`);
} else if (command === 'convert') {
  if (!target || !existsSync(target)) fail(`no such export: ${target ?? '(none given)'}`);
  const src = openSource(target);
  const adapter = o.from ? byName(o.from) : detect(src);
  if (!adapter) fail(o.from ? `unknown app "${o.from}"; see "sello-import apps"` : `couldn't tell which app ${target} is from; pass --from (see "sello-import apps")`);
  const map = Object.fromEntries((o.map ?? []).flatMap((m) => m.split(',')).map((kv) => kv.split('=').map((s) => s.trim())));
  const outDir = resolve(o.out ?? `${basename(target).replace(/\.[^.]+$/, '')}-sello`);
  if (existsSync(outDir) && readdirSync(outDir).length && !isImportFolder(outDir)) fail(`${outDir} exists and isn't a sello-import folder; pick another --out`);
  let result;
  try {
    result = writeEntries(outDir, src, adapter.name, adapter.read(src, { map }), { autoTitle: !o['no-title'] });
  } catch (err) {
    fail(err.message);
  } finally {
    src.close();
  }
  console.log(`Read as ${adapter.name}: ${result.entries.length} entries, ${result.files} ${result.files === 1 ? 'photo or video' : 'photos and videos'} → ${outDir}`);
  if (result.warnings.length) console.log(`${result.warnings.length} note(s):\n  ${result.warnings.slice(0, 50).join('\n  ')}${result.warnings.length > 50 ? `\n  …and ${result.warnings.length - 50} more` : ''}`);
  console.log(`\nNext: sello-import upload ${outDir} --dry-run`);
  console.log('That folder holds your journal unencrypted; delete it when done (sello-import cleanup).');
} else if (command === 'upload') {
  if (!target) fail('which folder? (the one convert wrote)');
  const limit = o.limit ? Number(o.limit) : Infinity;
  if (!(limit > 0)) fail('--limit must be a number');
  try {
    const r = await upload(resolve(target), {
      server: o.server ?? process.env.SELLO_SERVER ?? 'https://sello.voypalante.com',
      dryRun: o['dry-run'], limit, place: o.place, showLogin,
    });
    process.exit(r.ok ? 0 : 1);
  } catch (err) {
    fail(err.message);
  }
} else if (command === 'cleanup') {
  if (!target) fail('which folder?');
  const dir = resolve(target);
  if (!isImportFolder(dir)) fail(`${dir} isn't a folder written by sello-import; nothing deleted`);
  if (!o.yes) {
    console.log(`This deletes ${dir} (your converted journal, unencrypted). Run again with --yes to do it.`);
    process.exit(0);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`Deleted ${dir}. Your original export is untouched; delete it too if you no longer need it.`);
} else {
  fail(`unknown command "${command}"\n\n${HELP}`);
}
