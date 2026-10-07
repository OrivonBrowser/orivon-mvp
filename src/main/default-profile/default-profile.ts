// What a new profile starts with: the bookmarks of its bar and the extensions installed for it. This file
// only describes them and reads their files; the stores that keep them seed themselves from it.
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'

export const DEFAULT_PROFILE_ENV = 'ORIVON_DEFAULT_PROFILE'

/** `off` skips every seed, so a profile starts blank; anything else, and no value, seeds. */
export function defaultProfileOn (env: NodeJS.ProcessEnv): boolean {
  return env[DEFAULT_PROFILE_ENV] !== 'off'
}

/** Where the default profile's files are: beside the app in a package, in the repository's `resources/` otherwise.
 * `moduleDir` is the folder of the bundled main process, `out/main/`, two levels under the repository root. */
export function defaultProfileDir (where: { packaged: boolean, resourcesPath: string, moduleDir: string }): string {
  return where.packaged ? join(where.resourcesPath, 'default-profile') : resolve(where.moduleDir, '../../resources/default-profile')
}

export interface DefaultBookmark {
  title: string
  url: string
  /** A file in `bookmark-icons/` of the default profile's folder. */
  icon: string
}

/** The bar of a new profile, in order. The store keeps each address as it keeps a starred page's: an `ipfs://` name
 * at the origin it is served at (`ipfs://vitalik.eth` is `https://vitalik.eth/`), which is the URL its tab shows. */
export const DEFAULT_BOOKMARKS: readonly DefaultBookmark[] = [
  { title: 'Uniswap', url: 'https://app.uniswap.org', icon: 'uniswap.png' },
  { title: 'James Carnley', url: 'ipfs://jamescarnley.eth/', icon: 'jamescarnley.png' },
  { title: 'ENS Interviews', url: 'ipfs://ensinterviews.eth/', icon: 'ensinterviews.png' },
  { title: 'Web3 Compass', url: 'https://web3compass.net', icon: 'web3compass.png' },
  { title: 'Vitalik Buterin', url: 'ipfs://vitalik.eth', icon: 'vitalik.png' }
]

/** An icon is stored as a `data:` URL, as every bookmark's is. A file that cannot be read gives no icon: the
 * bookmark still goes in, and the bar then asks for the site's own. */
async function iconOf (dir: string, file: string): Promise<string | null> {
  try {
    return `data:image/png;base64,${(await readFile(join(dir, 'bookmark-icons', file))).toString('base64')}`
  } catch {
    return null
  }
}

export async function defaultBookmarks (dir: string): Promise<BookmarkTreeInput[]> {
  return Promise.all(DEFAULT_BOOKMARKS.map(async (entry): Promise<BookmarkTreeInput> => ({
    kind: 'url', title: entry.title, url: entry.url, favicon: await iconOf(dir, entry.icon)
  })))
}

export interface BundledExtension {
  name: string
  /** The packed extension, a `.crx` inside the default profile's `extensions/` folder. */
  path: string
  /** Whether it is installed pinned to the toolbar. */
  pinned: boolean
}

/** The extensions a new profile installs, from `bundled-extensions.json`. An entry whose file is not there (the fetch
 * did not run, or failed) is passed to `report` and left out; so is a list that cannot be read. Never throws. */
export async function bundledExtensions (dir: string, report: (problem: string) => void): Promise<BundledExtension[]> {
  let listed: unknown
  try {
    listed = JSON.parse(await readFile(join(dir, 'bundled-extensions.json'), 'utf8'))
  } catch (error) {
    report(`the bundled extensions list cannot be read: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  if (!Array.isArray(listed)) {
    report('the bundled extensions list is not an array')
    return []
  }
  const found: BundledExtension[] = []
  for (const entry of listed as unknown[]) {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const { file, name, pinned } = item
    if (typeof file !== 'string' || !/^[\w.-]+\.crx$/.test(file) || file.includes('..') || typeof name !== 'string') {
      report('a bundled extensions entry has no usable file or name')
      continue
    }
    const path = join(dir, 'extensions', file)
    try {
      await access(path)
    } catch {
      report(`${name} is not installed: ${path} is missing (node scripts/fetch-bundled-extensions.mjs fetches it)`)
      continue
    }
    found.push({ name, path, pinned: pinned === true })
  }
  return found
}
