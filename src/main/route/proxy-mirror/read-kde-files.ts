// Opens the `kioslaverc` files that hold KDE's proxy settings, in the places Chromium looks and no others, and hands their text to
// the parser. Tied to the operating system: it reads files, bounded in size and time.

import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { within } from '../within.js'
import { parseKdeSettings } from './read-kde.js'
import { READ_TIMEOUT_MS } from './run-readers.js'
import { kdeVersionOf } from './settings-source.js'
import type { SystemSettings } from './settings-source.js'

/** A settings file is a few lines; one this large is not read. */
const MOST_FILE_BYTES = 1_048_576

type Environment = Readonly<Record<string, string | undefined>>

export interface KdeFileSystem {
  /** The text of the file, or undefined when it cannot be opened, which Chromium takes for a file that is not there. Rejects for a file too large to read. */
  readonly read: (path: string) => Promise<string | undefined>
  /** When the file or directory was last changed, or undefined when it is not there. */
  readonly modifiedAt: (path: string) => Promise<number | undefined>
}

export const nodeFileSystem: KdeFileSystem = {
  read: async (path) => {
    const handle = await open(path, 'r').catch(() => undefined)
    if (handle === undefined) return undefined
    try {
      if ((await handle.stat()).size > MOST_FILE_BYTES) throw new Error('the settings file is too large')
      return await handle.readFile('utf8').catch(() => undefined)
    } finally {
      await handle.close()
    }
  },
  modifiedAt: async (path) => await stat(path).then((info) => info.mtimeMs, () => undefined)
}

/**
 * The directories Chromium reads `kioslaverc` from, lowest priority first, or undefined when it has none to look in. `KDEHOME`
 * names the only one when it is set. Otherwise KDE 5 and 6 keep it in `$HOME/.config` and in the `XDG_CONFIG_DIRS` (the
 * earlier an entry, the higher its priority, and `$HOME/.config` above them all): `XDG_CONFIG_HOME` is never consulted, though
 * KDE writes to it. KDE 4 uses `~/.kde` or `~/.kde4`, whichever was changed last, and KDE 3 `~/.kde`.
 */
export async function kdeConfigDirectories (env: Environment, files: Pick<KdeFileSystem, 'modifiedAt'>): Promise<string[] | undefined> {
  const kdeHome = env['KDEHOME'] ?? ''
  if (kdeHome !== '') return [join(kdeHome, 'share', 'config')]
  const home = env['HOME'] ?? ''
  const version = kdeVersionOf(env)
  if (home === '' || version === undefined) return undefined
  if (version === 5 || version === 6) {
    const others = (env['XDG_CONFIG_DIRS'] ?? '').split(':').filter((dir) => dir !== '')
    return [...others.reverse(), join(home, '.config')]
  }
  const kde3 = join(home, '.kde', 'share', 'config')
  if (version === 3) return [kde3]
  const kde4 = join(home, '.kde4', 'share', 'config')
  const [older, newer] = await Promise.all([files.modifiedAt(kde3), files.modifiedAt(kde4)])
  return [newer !== undefined && (older === undefined || newer >= older) ? kde4 : kde3]
}

/** KDE's proxy settings; `unreadable` when no place can be worked out to look in, or a read fails or takes too long. A computer with no `kioslaverc` has no KDE proxy settings, which reads as `none`. */
export async function readKdeSettings (env: Environment = process.env, files: KdeFileSystem = nodeFileSystem): Promise<SystemSettings> {
  try {
    return await within((async (): Promise<SystemSettings> => {
      const directories = await kdeConfigDirectories(env, files)
      if (directories === undefined) return { kind: 'unreadable' }
      const texts = await Promise.all(directories.map(async (dir) => await files.read(join(dir, 'kioslaverc'))))
      return parseKdeSettings(texts.filter((text): text is string => text !== undefined))
    })(), READ_TIMEOUT_MS, 'the settings files could not be read in time')
  } catch {
    return { kind: 'unreadable' }
  }
}
