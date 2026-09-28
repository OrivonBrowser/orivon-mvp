// What a new profile or a private session is given from the default profile's
// directory: the light client's verified checkpoint, which is public, and
// without which a `.eth` name would fail once the shipped one is old. Nothing
// that says what the person has done: not the list of IPNS names they have
// visited that sits beside it, not history, bookmarks, grants, apps, identity
// or site data.
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const PUBLIC_SEED = [join('verifier', 'checkpoint.json')] as const

/** Copies the seed files that exist under `home` into `into`. A file that is missing or is a link is skipped. */
export function copyPublicSeed (home: string, into: string): void {
  for (const item of PUBLIC_SEED) {
    const from = join(home, item)
    try {
      if (!lstatSync(from).isFile()) continue
    } catch {
      continue
    }
    const to = join(into, item)
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    copyFileSync(from, to)
  }
}
