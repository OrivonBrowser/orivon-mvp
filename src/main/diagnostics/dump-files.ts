// Reads and prunes the dump folder. Where Crashpad writes with uploads off is measured in README.md (Design notes).
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dumpsToDelete } from './dumps.js'
import type { DumpFile } from './dumps.js'

/** Crashpad's folders: Linux and macOS keep a report that is not uploaded in `pending`; Windows keeps its reports in `reports`. */
const DUMP_FOLDERS = ['pending', 'completed', 'reports']

/** Every `.dmp` file under the crash folder. A folder that is missing or unreadable has none. */
export function listDumps (crashDumpsDir: string): DumpFile[] {
  const found: DumpFile[] = []
  for (const folder of DUMP_FOLDERS) {
    let names: string[]
    try {
      names = readdirSync(join(crashDumpsDir, folder))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.dmp')) continue
      const path = join(crashDumpsDir, folder, name)
      try {
        const info = statSync(path)
        if (info.isFile()) found.push({ path, mtimeMs: info.mtimeMs, bytes: info.size })
      } catch {
        // Deleted between the listing and the look: nothing to show.
      }
    }
  }
  return found
}

/** Deletes the dumps `dumpsToDelete` names, with the report file Crashpad keeps beside each. */
export function pruneDumps (crashDumpsDir: string, nowMs: number): void {
  for (const dump of dumpsToDelete(listDumps(crashDumpsDir), nowMs)) {
    rmSync(dump.path, { force: true })
    rmSync(dump.path.replace(/\.dmp$/, '.meta'), { force: true })
  }
}

/** The dump's bytes as standard base64, for a report. */
export function readDumpBase64 (dump: DumpFile): string {
  return readFileSync(dump.path).toString('base64')
}
