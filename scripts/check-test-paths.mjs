/**
 * Fails when a tracked text file names a path under `test/` that does not exist: a spec, a helper, a
 * folder, a glob that matches nothing, or a relative `../test/...` link that does not resolve from the file
 * that holds it. It keeps documentation, CI and scripts honest when specs move, and nothing else checks
 * Markdown links into `test/`.
 *
 * A token followed by `<` or `{` is a placeholder and is skipped. History (CHANGELOG, decisions, the
 * open-questions and readability logs, the devlog, most of docs/planning) is exempt: it says what was true
 * when it was written (CLAUDE.md Rule 2). Imports `node:*` only.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'

const TEXT_EXT = /\.(md|ts|tsx|mjs|js|json|yml|yaml)$/
const SKIPPED_FILES = /(^|\/)(package-lock\.json|[^/]*\.generated\.[^/]*)$/
/** Prefixes of files whose content describes the past, or builds synthetic repositories. */
const EXEMPT_PREFIXES = [
  'CHANGELOG.md', 'docs/decisions/', 'docs/open-questions.md', 'docs/development/readability-log.md',
  'docs/development/review-coverage.md', 'devlog/', 'docs/planning/'
]
/** Under `docs/planning/`, these are live pages and are checked. */
const CHECKED_PLANNING = ['docs/planning/build-plan.md', 'docs/planning/compatibility-matrix.md', 'docs/planning/compatibility/']
const SYNTHETIC = /^scripts\/(?:[^/]+\/)*tests\//
const TOKEN = /(?<![\w.:@/-])((?:\.\.\/)*)test\/[\w.@+*-]+(?:\/[\w.@+*-]+)*/g

export function isExempt (file) {
  if (SYNTHETIC.test(file)) return true
  if (CHECKED_PLANNING.some((prefix) => file.startsWith(prefix))) return false
  return EXEMPT_PREFIXES.some((prefix) => file === prefix || (prefix.endsWith('/') && file.startsWith(prefix)))
}

/** Every `test/...` token in `text`, with its line and the `../` prefix it carried. */
export function findTokens (text) {
  const found = []
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(TOKEN)) {
      const after = line[match.index + match[0].length]
      if (after === '<' || after === '{') continue
      const trimmed = match[0].replace(/[./+@-]+$/, '')
      const token = trimmed.slice(match[1].length)
      if (!token.startsWith('test/')) continue
      found.push({ token, prefix: match[1], line: i + 1 })
    }
  })
  return found
}

/** The files and every directory above them, for existence checks. */
export function pathSet (files) {
  const set = new Set()
  for (const file of files) {
    let current = file
    while (current !== '.' && !set.has(current)) {
      set.add(current)
      current = posix.dirname(current)
    }
  }
  return set
}

function globToRegExp (glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/(?<![.)])\*/g, '[^/]*')}$`)
}

/**
 * @param {string} root Repository root.
 * @param {string[]} files Tracked files, relative to `root`.
 * @param {(file: string) => string | null} [read] Returns a file's text, or null to skip it.
 * @returns {{ ok: boolean, dangling: Array<{ file: string, line: number, token: string }> }}
 */
export function checkTestPaths (root, files, read = (file) => { try { return readFileSync(join(root, file), 'utf8') } catch { return null } }) {
  const paths = pathSet(files)
  const dangling = []
  for (const file of files) {
    if (!TEXT_EXT.test(file) || SKIPPED_FILES.test(file) || isExempt(file)) continue
    const text = read(file)
    if (text === null) continue
    for (const { token, prefix, line } of findTokens(text)) {
      const target = prefix === '' ? token : posix.normalize(posix.join(dirname(file), prefix, token))
      const resolved = token.includes('*') ? [...paths].some((path) => globToRegExp(prefix === '' ? token : target).test(path)) : paths.has(target)
      if (!resolved) dangling.push({ file, line, token: `${prefix}${token}` })
    }
  }
  return { ok: dangling.length === 0, dangling }
}

export function trackedFiles (root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter((file) => file !== '')
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const { ok, dangling } = checkTestPaths(root, trackedFiles(root))
  if (!ok) {
    console.error('\nPaths under test/ that do not exist (a spec moved, or a path was mistyped):\n')
    for (const { file, line, token } of dangling) console.error(`  ${file}:${line}  ${token}`)
    console.error('\nFix the path, or write a placeholder as test/<area>/<file>.\n')
    process.exit(1)
  }
  console.log('Every path under test/ named in a tracked file exists.')
}
