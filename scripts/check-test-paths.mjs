/**
 * Fails when a tracked text file names a path under `test/` that does not exist: a spec, a helper, a
 * folder, a glob that matches nothing, or a relative `../test/...` link that does not resolve from the file
 * that holds it. It keeps documentation, CI and scripts honest when specs move, and nothing else checks
 * Markdown links into `test/`.
 *
 * It also keeps `test/` ordered: no spec sits directly in `test/`, every folder under it has a row in the
 * Layout table of `test/README.md`, and every row names a folder that exists.
 *
 * A token followed by `<`, `{` or `$` is a placeholder and is skipped. History (CHANGELOG, decisions, the
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
      if (after === '<' || after === '{' || after === '$') continue
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
  const marked = glob.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '\u0003')
  const escaped = marked.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*').replace(/\u0003/g, '[^/]*')}$`)
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

/**
 * The ordering rules for `test/`, from the tracked file list and the README's text.
 * @returns {string[]} one message per violation
 */
export function checkLayout (files, readme) {
  const problems = []
  for (const file of files) {
    if (/^test\/[^/]+\.test\.ts$/.test(file)) problems.push(`${file}: a spec belongs in a folder of its area under test/, not at its top; see the Layout table in test/README.md`)
  }
  const folders = new Set(files.filter((file) => /^test\/[^/]+\//.test(file)).map((file) => file.split('/')[1]))
  const rows = new Set()
  const start = readme.indexOf('\n## Layout')
  const section = start === -1 ? '' : readme.slice(start + 1).split(/\n## /)[0]
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const first = line.split('|')[1] ?? ''
    for (const m of first.matchAll(/`([\w.-]+)\/`/g)) rows.add(m[1])
  }
  for (const folder of [...folders].sort()) {
    if (!rows.has(folder)) problems.push(`test/${folder}/ has no row in the Layout table of test/README.md: say what it proves, or put its files in an existing area`)
  }
  for (const row of [...rows].sort()) {
    if (!folders.has(row)) problems.push(`the Layout table of test/README.md names ${row}/, which does not exist`)
  }
  return problems
}

export function trackedFiles (root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter((file) => file !== '')
}

if (isInvokedDirectly(import.meta.url)) {
  const root = process.cwd()
  const files = trackedFiles(root)
  const { ok, dangling } = checkTestPaths(root, files)
  let readme = ''
  try { readme = readFileSync(join(root, 'test/README.md'), 'utf8') } catch { /* every folder then lacks a row */ }
  const layout = checkLayout(files, readme)
  if (!ok) {
    console.error('\nPaths under test/ that do not exist (a spec moved, or a path was mistyped):\n')
    for (const { file, line, token } of dangling) console.error(`  ${file}:${line}  ${token}`)
    console.error('\nFix the path, or write a placeholder as test/<area>/<file>.\n')
  }
  if (layout.length > 0) {
    console.error('\ntest/ is not ordered:\n')
    for (const problem of layout) console.error(`  ${problem}`)
    console.error('')
  }
  if (!ok || layout.length > 0) process.exit(1)
  console.log('Every path under test/ named in a tracked file exists, and test/ is ordered as its README says.')
}
