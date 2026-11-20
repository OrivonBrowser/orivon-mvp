// Writes the licence texts of every package the three builds bundle into one file, `out/THIRD-PARTY-NOTICES.txt`,
// which electron-builder ships beside the app (electron-builder.yml `extraResources`). A bundled package no
// longer travels with its own folder, and an MIT, BSD or Apache licence asks for its notice wherever its code
// goes. The main, preload and renderer builds run one after another in one process (electron-vite build), so each
// adds the modules it loaded to a shared set and the last one writes the file.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type { Plugin } from 'vite'

/** One bundled package, or one vendored folder, and the licence files at its top level. */
export interface Notice {
  readonly name: string
  readonly version: string
  /** The `license` field of its package.json, or '' when it has none. */
  readonly licence: string
  readonly texts: readonly { readonly file: string, readonly text: string }[]
}

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i
const NODE_MODULES = '/node_modules/'

/** The folders of the packages the builds so far loaded. */
const bundled = new Set<string>()

/** Vite hands out module ids with forward slashes on every system; so do the paths here. */
const slashed = (path: string): string => path.replace(/\\/g, '/')

/**
 * The folder of the package a module id belongs to: the one after the last `node_modules/` (a scoped name takes two
 * segments), or `vendor/<name>` for the repository's vendored code. Undefined for Orivon's own code and for ids a
 * plugin made up (they start with a NUL character or have no folder).
 */
export function packageDirOf (id: string, root: string): string | undefined {
  const file = slashed(id.split('?')[0] ?? '').replace(/^\0(?:[\w-]{2,}:)?/, '')
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

/** What a folder says about itself, or undefined when it holds no package.json and no licence file. */
export function noticeOf (dir: string, fallbackName: string): Notice | undefined {
  let manifest: { name?: unknown, version?: unknown, license?: unknown } = {}
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
  if (texts.length === 0 && manifest.license === undefined) return undefined
  return {
    name: typeof manifest.name === 'string' ? manifest.name : fallbackName,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    licence: typeof manifest.license === 'string' ? manifest.license : '',
    texts
  }
}

/** The file's text: a header, then each notice under its name and version, sorted, one copy of each. */
export function renderNotices (notices: readonly Notice[]): string {
  const unique = new Map(notices.map((notice) => [notice.version === '' ? notice.name : `${notice.name}@${notice.version}`, notice]))
  const rule = '='.repeat(72)
  const sections = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, notice]) => {
    const declared = notice.licence !== '' ? `licence: ${notice.licence}` : notice.version === '' ? 'vendored in the Orivon repository' : 'no licence declared in its package.json'
    const body = notice.texts.length === 0
      ? 'The package ships no licence file.'
      : notice.texts.map(({ file, text }) => (notice.texts.length > 1 ? `${file}\n\n${text}` : text)).join('\n\n')
    return `${rule}\n${key} (${declared})\n${rule}\n\n${body}\n`
  })
  return [
    'Third-party notices',
    '',
    'The packages and vendored folders below are bundled into this application. Each is under its own licence,',
    'reproduced here from the folder it came from. Orivon itself is under its own licence (LICENSE in its source',
    'repository).',
    '',
    ...sections
  ].join('\n') + '\n'
}

/**
 * Collects the packages a build loads. With `outFile` (relative to `root`), it also writes the file once the
 * build has ended: give it to the last build of the run only (the renderer's), since the others have added theirs by then.
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
      const notices = [...bundled].filter((dir) => existsSync(dir)).flatMap((dir) => {
        const notice = noticeOf(dir, dir.slice(slashed(root).length + 1))
        return notice === undefined ? [] : [notice]
      })
      writeFileSync(posix.join(slashed(root), outFile), renderNotices(notices))
    }
  }
}
