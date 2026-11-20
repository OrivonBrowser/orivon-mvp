// Writes the licence texts of every package the builds bundle into `out/THIRD-PARTY-NOTICES.txt`, which
// electron-builder ships beside the app. docs/development/packaging.md section Licence notices says what it
// collects and why. The main, preload and renderer builds run one after another in one process, each adds the
// packages it loaded to a shared set, and the last one (the renderer's, given `outFile`) writes the file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { standardTexts } from './licence-texts.js'

/** One bundled package, or one vendored folder, and its licence text. */
export interface Notice {
  readonly name: string
  readonly version: string
  /** The `license` field of its package.json, or '' when it has none. */
  readonly licence: string
  readonly texts: readonly { readonly file: string, readonly text: string }[]
  /** True when the package ships no licence file and `texts` are the standard texts of the licence it declares. */
  readonly generated?: boolean
}

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i
const NODE_MODULES = '/node_modules/'
const GENERATED_JSON = /\.generated\.json$/

/** The folders of the packages the builds so far loaded. */
const bundled = new Set<string>()
/** The folders a prebuilt bundle held as JSON names (`embeddedPackages`): a missing one fails the build. */
const embedded = new Set<string>()

/** Vite hands out module ids with forward slashes on every system; so do the paths here. */
const slashed = (path: string): string => path.replace(/\\/g, '/')

/** A module id's file: no query, no plugin prefix (a NUL character, then an optional `name:`). */
const fileOf = (id: string): string => slashed(id.split('?')[0] ?? '').replace(/^\0(?:[\w-]{2,}:)?/, '')

/**
 * The folder of the package a module id belongs to: the one after the last `node_modules/` (a scoped name takes two
 * segments), or `vendor/<name>` for the repository's vendored code. Undefined for Orivon's own code and for ids a
 * plugin made up (they start with a NUL character or have no folder).
 */
export function packageDirOf (id: string, root: string): string | undefined {
  const file = fileOf(id)
  const at = file.lastIndexOf(NODE_MODULES)
  if (at !== -1) {
    const parts = file.slice(at + NODE_MODULES.length).split('/')
    const name = parts[0]?.startsWith('@') === true ? parts.slice(0, 2).join('/') : parts[0]
    return name === undefined || name === '' ? undefined : file.slice(0, at + NODE_MODULES.length) + name
  }
  const vendor = `${slashed(root)}/vendor/`
  if (file.startsWith(vendor)) {
    const name = file.slice(vendor.length).split('/')[0]
    return name === undefined || name === '' ? undefined : vendor + name
  }
  return undefined
}

/**
 * The package folders a prebuilt bundle held as a `*.generated.json` module is made of, from its `packages` field
 * (folders relative to `root`, written by the bundle's generator from the bundler's metafile): the build sees the
 * JSON as one module, not the packages inside its string. Empty for any other file.
 */
export function embeddedPackages (id: string, root: string): string[] {
  const file = fileOf(id)
  if (!GENERATED_JSON.test(file)) return []
  const { packages } = JSON.parse(readFileSync(file, 'utf8')) as { packages?: unknown }
  if (!Array.isArray(packages)) return []
  return packages.filter((entry): entry is string => typeof entry === 'string').map((entry) => posix.join(slashed(root), entry))
}

/** The name a package.json gives as the author, without the email and the address after it. */
function authorOf (author: unknown): string {
  const named = typeof author === 'string' ? author : typeof author === 'object' && author !== null ? (author as { name?: unknown }).name : undefined
  return typeof named === 'string' ? named.replace(/<[^>]*>|\([^)]*\)/g, '').trim() : ''
}

/** The copyright holder of a package that ships no licence file: its author, else the project its repository field names. */
function holderOf (manifest: { name?: unknown, author?: unknown, repository?: unknown }, fallbackName: string): string {
  const author = authorOf(manifest.author)
  if (author !== '') return author
  const name = typeof manifest.name === 'string' ? manifest.name : fallbackName
  const repository = typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository as { url?: unknown } | undefined)?.url
  const address = typeof repository === 'string' ? repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '') : ''
  return address === '' ? `the authors of ${name}` : `the contributors to ${name} (${address})`
}

/**
 * What a folder says about itself, or undefined when it holds no package.json and no licence file. A package with no
 * licence file takes the standard text of the SPDX licence it declares (`licence-texts.ts`); one whose licence has no
 * text there throws, so the notices file never holds a package without its text.
 */
export function noticeOf (dir: string, fallbackName: string): Notice | undefined {
  let manifest: { name?: unknown, version?: unknown, license?: unknown, author?: unknown, repository?: unknown } = {}
  try {
    manifest = JSON.parse(readFileSync(posix.join(dir, 'package.json'), 'utf8'))
  } catch { /* a vendored folder has no package.json */ }
  const files = readdirSync(dir).filter((file) => LICENCE_FILE.test(file)).sort()
  const texts = files.flatMap((file) => {
    try {
      return [{ file, text: readFileSync(posix.join(dir, file), 'utf8').trim() }]
    } catch {
      return []
    }
  })
  const name = typeof manifest.name === 'string' ? manifest.name : fallbackName
  const licence = typeof manifest.license === 'string' ? manifest.license : ''
  const notice = { name, version: typeof manifest.version === 'string' ? manifest.version : '', licence }
  if (texts.length > 0) return { ...notice, texts }
  if (manifest.license === undefined) return undefined
  const standard = standardTexts(licence, holderOf(manifest, fallbackName))
  if (standard === undefined) {
    throw new Error(`${name} declares the licence ${JSON.stringify(manifest.license)} and ships no licence file, and scripts/licence-texts.ts holds no text for it: add one, or the notices file would hold none for ${name}`)
  }
  return { ...notice, texts: standard.map(({ id, text }) => ({ file: id, text })), generated: true }
}

/** The file's text: a header, then each notice under its name and version, sorted, one copy of each. */
export function renderNotices (notices: readonly Notice[]): string {
  const unique = new Map(notices.map((notice) => [notice.version === '' ? notice.name : `${notice.name}@${notice.version}`, notice]))
  const rule = '='.repeat(72)
  const sections = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, notice]) => {
    const declared = notice.licence !== '' ? `licence: ${notice.licence}` : notice.version === '' ? 'vendored in the Orivon repository' : 'no licence declared in its package.json'
    const body = notice.texts.length === 0
      ? 'The package ships no licence file.'
      : notice.generated === true
        ? `The package ships no licence file. The standard ${notice.texts.map(({ file }) => file).join(' and ')} text follows, with the copyright holder its package.json names.\n\n${notice.texts.map(({ text }) => text).join('\n\n')}`
        : notice.texts.map(({ file, text }) => (notice.texts.length > 1 ? `${file}\n\n${text}` : text)).join('\n\n')
    return `${rule}\n${key} (${declared})\n${rule}\n\n${body}\n`
  })
  return [
    'Third-party notices',
    '',
    'The packages and vendored folders below are bundled into this application. Each is under its own licence,',
    'reproduced here from the folder it came from, or, for a package that ships none, as the standard text of the',
    'licence its package.json declares. Orivon itself is under its own licence (LICENSE in its source repository).',
    '',
    ...sections
  ].join('\n') + '\n'
}

/**
 * Collects the packages a build loads. With `outFile` (relative to `root`), it also writes the file once the
 * build has ended: give it to the last build of the run only (the renderer's), since the others have added theirs by then.
 * A build that starts another (the page buffer, the chunk check thread) gives that one this plugin without `outFile`.
 */
export function licenceNotices (root: string, outFile?: string): Plugin {
  let buildRoot = root
  return {
    name: 'orivon:licence-notices',
    apply: 'build',
    configResolved (config) {
      buildRoot = config.root
    },
    buildEnd () {
      for (const id of this.getModuleIds()) {
        const dir = packageDirOf(id, root)
        if (dir !== undefined) bundled.add(dir)
        else for (const embeddedDir of embeddedPackages(id, root)) embedded.add(embeddedDir)
      }
    },
    // A font or an image a stylesheet names by package (`url('@fontsource-variable/inter/files/...')`) is an asset, not a module.
    generateBundle (_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset') continue
        for (const original of output.originalFileNames) {
          const dir = packageDirOf(resolve(buildRoot, original), root)
          if (dir !== undefined) bundled.add(dir)
        }
      }
    },
    writeBundle () {
      if (outFile === undefined) return
      for (const dir of embedded) {
        if (!existsSync(dir)) throw new Error(`a prebuilt bundle names the package folder ${dir}, which is not installed: regenerate the bundle (src/shim/worker/README.md)`)
      }
      const dirs = [...new Set([...[...bundled].filter((dir) => existsSync(dir)), ...embedded])]
      const notices = dirs.flatMap((dir) => {
        const notice = noticeOf(dir, dir.slice(slashed(root).length + 1))
        if (notice === undefined && dir.includes(NODE_MODULES)) throw new Error(`${dir} declares no licence and ships no licence file: decide whether it may ship, then name it here`)
        return notice === undefined ? [] : [notice]
      })
      writeFileSync(posix.join(slashed(root), outFile), renderNotices(notices))
    }
  }
}
