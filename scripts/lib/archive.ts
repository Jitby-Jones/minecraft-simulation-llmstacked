// The export archive (§23.4): DATA_DIR under data/ and the config under config/, in one .tar.gz. Left out: the
// .env (it never leaves the machine), caches and everything `pnpm run setup` downloads again (the Paper jar and its
// libraries, plugin jars, the embedding model), test data, and logs unless asked for. Import takes plain files and
// directories only, so an archive can't plant links or write outside its two folders.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import * as tar from 'tar';

export interface ExportOptions {
  dataDir: string;
  configDir: string;
  out: string;
  withLogs?: boolean;
}

/** Whether a path inside DATA_DIR (relative, forward slashes) goes into the archive. */
export function exportable(rel: string, withLogs = false): boolean {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p === '.') return true;
  const top = p.split('/')[0] ?? '';
  if (['cache', 'live-test'].includes(top)) return false;
  if (top === 'logs' && !withLogs) return false;
  if (/^server\/(cache|libraries|versions|bundler)(\/|$)/.test(p)) return false;
  if (/^server\/logs(\/|$)/.test(p) && !withLogs) return false;
  if (/^server\/[^/]+\.jar$/.test(p) || /^server\/plugins\/[^/]+\.jar$/.test(p)) return false;
  if (/(^|\/)\.env$/.test(p) || /\.tmp$/.test(p) || /(^|\/)session\.lock$/.test(p)) return false;
  return true;
}

export async function createExport(o: ExportOptions): Promise<{ files: number; bytes: number }> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-export-')), 'export.tar');
  let files = 0;
  try {
    await tar.c(
      {
        file: tmp,
        cwd: o.dataDir,
        prefix: 'data',
        portable: true,
        filter: (p, st) => {
          const ok = exportable(p, o.withLogs) && !('isSymbolicLink' in st && st.isSymbolicLink());
          if (ok && 'isFile' in st && st.isFile()) files++;
          return ok;
        },
      },
      ['.'],
    );
    if (fs.existsSync(o.configDir)) {
      await tar.r(
        {
          file: tmp,
          cwd: path.dirname(o.configDir),
          portable: true,
          filter: (p, st) => {
            const ok = !/(^|\/)\.env$/.test(p) && !('isSymbolicLink' in st && st.isSymbolicLink());
            if (ok && 'isFile' in st && st.isFile()) files++;
            return ok;
          },
        },
        [path.basename(o.configDir)],
      );
    }
    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 6 }), fs.createWriteStream(o.out));
    return { files, bytes: fs.statSync(o.out).size };
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export interface ImportOptions {
  file: string;
  dataDir: string;
  configDir: string;
}

/** Unpacks data/ into DATA_DIR and config/ into the config folder. Both should be empty or set aside first. */
export async function extractExport(o: ImportOptions): Promise<{ data: number; config: number; skipped: string[] }> {
  const skipped: string[] = [];
  let data = 0;
  let config = 0;
  const staging = fs.mkdtempSync(path.join(path.dirname(o.dataDir), '.agora-import-'));
  try {
    await tar.x({
      file: o.file,
      cwd: staging,
      strict: true,
      preservePaths: false,
      filter: (p, entry) => {
        const type = 'type' in entry ? entry.type : 'File';
        const top = p.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0];
        // Never a .env, even in a hand-made archive: the key stays on the machine it was typed into.
        const ok = (type === 'File' || type === 'Directory') && (top === 'data' || top === 'config') && !/(^|\/)\.env$/.test(p);
        if (!ok) skipped.push(p);
        else if (type === 'File' && top === 'data') data++;
        else if (type === 'File') config++;
        return ok;
      },
    });
    // Merged in: what setup already downloaded here (the Paper jar, its libraries) stays; the archive's files win.
    const move = (from: string, to: string): void => {
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, e.name);
        const dst = path.join(to, e.name);
        if (e.isDirectory() && fs.existsSync(dst) && fs.statSync(dst).isDirectory()) move(src, dst);
        else {
          fs.rmSync(dst, { recursive: true, force: true });
          fs.renameSync(src, dst);
        }
      }
    };
    move(path.join(staging, 'data'), o.dataDir);
    move(path.join(staging, 'config'), o.configDir);
    return { data, config, skipped };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
