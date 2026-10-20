// An export as a list of files, whether it came as a ZIP, an unpacked folder, or a single file
// (a CSV, JSON or note: then the photos and videos around it come along).
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { isMedia } from './media.js';
import { openZip } from './zip.js';

function walk(root) {
  const names = [];
  const go = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      const full = join(dir, d.name);
      if (d.isDirectory()) go(full);
      else if (d.isFile()) names.push(relative(root, full).split(sep).join('/'));
    }
  };
  go(root);
  return names;
}

function isZip(path) {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    return b.readUInt32LE(0) === 0x04034b50 || b.readUInt32LE(0) === 0x06054b50;
  } finally {
    closeSync(fd);
  }
}

function folder(root, names) {
  return {
    names: () => names,
    read: (name) => readFileSync(join(root, name)),
    mtime: (name) => statSync(join(root, name)).mtimeMs,
    close() {},
  };
}

export function openSource(path) {
  if (statSync(path).isDirectory()) return folder(path, walk(path));
  if (!isZip(path)) {
    const root = dirname(path);
    const main = basename(path);
    return { ...folder(root, [main, ...walk(root).filter((n) => n !== main && isMedia(n))]), main };
  }
  const zip = openZip(path);
  // ZIPs often carry macOS metadata and hidden files; neither is part of the export.
  const all = zip.names().filter((n) => !n.startsWith('__MACOSX/') && !n.split('/').some((p) => p.startsWith('.')));
  return { names: () => all, read: zip.read, mtime: () => null, close: zip.close };
}
