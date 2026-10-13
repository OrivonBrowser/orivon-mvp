/**
 * Fails the build if a file in src/ can reach the network and docs/architecture/egress.md does not list it, or if
 * that page lists a file that is gone or that the scan no longer matches.
 *
 * The tunnel (ADR-0080) only holds if no path to the network is added around it unnoticed. The table says, for every
 * such file, what it reaches, what for, and how it takes the tunnel (or why it never leaves this computer). A file is
 * a path to the network when it imports `net`, `tls`, `http`, `https`, `http2`, `dgram` or `dns` (with or without
 * `node:`, a type-only import excepted), the `socks` package or the broker's socket adapters, calls Electron's
 * `net.request` or `net.fetch`, any `setProxy`, or `globalThis.fetch`, or, outside the renderer, the preload scripts
 * and the Node shim (code that runs in a page or a worker, whose `fetch` is the page's own), calls a session's
 * `fetch` or the global `fetch` without declaring a `fetch` of its own (a parameter, a destructured option or a
 * local: an injected one is the caller's path, and the caller is listed), falls back to the global `fetch`, or
 * constructs a `WebSocket`, `EventSource` or `XMLHttpRequest`.
 *
 * SCOPE: git-tracked source under src/, tests excluded. Regex over the code with comments blanked, not an AST
 * (scripts/README.md limits a guard to `node:*` builtins). A row may not name a
 * file the scan no longer matches, so the table cannot keep claiming a path that is gone. `deps.fetch` and
 * `options.fetch` are an injected function, not a session's.
 *
 * KNOWN LIMITS: a `fetch` declared anywhere in a file excuses every bare `fetch(` call in it, and the global `fetch`
 * passed as a value (`run(fetch)`) is seen only as a fallback (`?? fetch`). A program Orivon starts is not a path
 * this scan names.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, trackedFiles } from './cli.mjs'
import { blankComments } from './check-native-dialogs.mjs'

export const TABLE_FILE = 'docs/architecture/egress.md'

const SOURCE = /^src\/.*\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const NOT_SOURCE = /(^|\/)tests\/|\.test\.[cm]?[jt]sx?$|\.test-helpers\.[cm]?[jt]sx?$|\.d\.ts$/
/** Page-side code: it runs in a page or a worker of an app or of the shell, so its `fetch` is the page's own and reaches the network through the page's session. */
const PAGE_SIDE = /^src\/(renderer|preload|shim)\//

const MODULES = 'net|tls|http|https|http2|dgram|dns|dns\\/promises'
const IMPORT = /\b(?:import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*(['"])([^'"]+)\3/g
const NETWORK_MODULE = new RegExp(`^(?:node:)?(${MODULES})$`)
/** The broker's own Node socket adapters: whoever imports them dials, binds or resolves. */
const ADAPTER_MODULE = /\/adapters\/(?:node-adapters|tls-adapter|udp-adapter)(?:\.js)?$/
const SIDE_EFFECT_IMPORT = new RegExp(`\\bimport\\s*(['"])(?:node:)?(${MODULES})\\1`, 'g')
const CALLED_IMPORT = new RegExp(`\\b(?:require|import|getBuiltinModule)\\s*\\(\\s*(['"\`])(?:node:)?(${MODULES})\\1\\s*\\)`, 'g')
const ELECTRON_NET = /(?<![\w$])net\.(request|fetch)\s*\(/g
const FETCH_MEMBER = /([\w$]*)\s*\??\.\s*fetch\b/g
/** `this.fetch` is a method of the class itself, `deps.fetch` and `options.fetch` a function the caller passed in. */
const INJECTED = new Set(['deps', 'options', 'opts', 'this'])
const SET_PROXY = /\.setProxy\s*\(/
const BARE_FETCH = /(?<![\w$.])fetch\s*\(/
/** Falling back to the global `fetch` when none was injected: `deps.fetch ?? fetch`. A declaration elsewhere in the file does not excuse it. */
const FETCH_FALLBACK = /(?:\?\?|\|\|)\s*fetch\b(?!\s*[(:=])/
/** Electron's `net` under another name: `import { net as enet }`, `const { request } = net`. */
const NET_ALIAS = [/\{[^}]*\bnet\s+as\s+[\w$]+[^}]*\}\s*from\s*['"]electron['"]/, /\}\s*=\s*net\b(?![\w$.])/]
/** Other ways for Node-side code to open a connection of its own. */
const CONSTRUCTED = /\bnew\s+(WebSocket|EventSource|XMLHttpRequest)\b/g
/** A `fetch` the file declares itself: a local, an import, a destructured option, or a parameter or property typed as a function. */
const DECLARED_FETCH = [
  /\b(?:const|let|var|function)\s+fetch\b/,
  /\bimport\s+[^;'"]*\bfetch\b[^;'"]*from/,
  /[{,]\s*fetch\s*[,}]/,
  /[(,]\s*fetch\s*(?:[,)=]|=>)/,
  /(?:^|[\s(,{;])(?:readonly\s+)?fetch\s*\??:\s*(?:typeof\b|[A-Z])/m
]

/** True when an import clause brings in nothing at run time: `{ type A, type B }`. */
function onlyTypes (clause) {
  const braces = /^\{([^}]*)\}$/.exec(clause.trim())
  if (braces === null) return false
  const entries = braces[1].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return entries.length > 0 && entries.every((entry) => /^type\s/.test(entry))
}

/**
 * Why `text`, the source of `file`, is a path to the network: one phrase per reason, imports first. Empty when it is not.
 * @param {string} text
 * @param {string} file Root-relative path with forward slashes.
 * @returns {string[]}
 */
export function findEgress (text, file) {
  const code = blankComments(text)
  const reasons = []
  const add = (reason) => { if (!reasons.includes(reason)) reasons.push(reason) }

  for (const match of code.matchAll(IMPORT)) {
    if (match[1] !== undefined || onlyTypes(match[2])) continue
    const specifier = match[4]
    const network = NETWORK_MODULE.exec(specifier)
    if (network !== null) add(`imports node:${network[1]}`)
    else if (ADAPTER_MODULE.test(specifier)) add('imports the broker\'s socket adapters')
    else if (specifier === 'socks') add('imports socks')
  }
  for (const match of code.matchAll(SIDE_EFFECT_IMPORT)) add(`imports node:${match[2]}`)
  for (const match of code.matchAll(CALLED_IMPORT)) add(`imports node:${match[2]}`)

  for (const match of code.matchAll(ELECTRON_NET)) add(`calls net.${match[1]}`)
  for (const match of code.matchAll(FETCH_MEMBER)) {
    const receiver = match[1]
    if (receiver === 'globalThis') add('uses globalThis.fetch')
    else if (receiver !== 'net' && !INJECTED.has(receiver) && !PAGE_SIDE.test(file)) add('calls a session\'s fetch')
  }
  if (SET_PROXY.test(code)) add('calls setProxy')
  if (NET_ALIAS.some((alias) => alias.test(code))) add('uses Electron net under another name')
  if (!PAGE_SIDE.test(file)) for (const match of code.matchAll(CONSTRUCTED)) add(`constructs a ${match[1]}`)
  if (!PAGE_SIDE.test(file) && FETCH_FALLBACK.test(code)) add('falls back to the global fetch')
  if (!PAGE_SIDE.test(file) && BARE_FETCH.test(code) && !DECLARED_FETCH.some((declared) => declared.test(code))) add('calls the global fetch')
  return reasons
}

/** The paths the table names: the first backticked `src/...` cell of every row, in any table on the page. */
export function tableFiles (markdown) {
  const files = new Set()
  for (const line of markdown.split('\n')) {
    const row = /^\|\s*`(src\/[^`\s]+)`\s*\|/.exec(line)
    if (row !== null) files.add(row[1])
  }
  return files
}

/**
 * @param {string} root Directory to check, typically the repo root.
 * @returns {{ ok: boolean, unlisted: Array<{file: string, reasons: string[]}>, stale: string[],
 *   unreadable: Array<{file: string, error: string}>, error?: string }}
 */
export function checkEgress (root) {
  const unlisted = []
  const stale = []
  const unreadable = []
  let files
  try {
    files = trackedFiles(root)
  } catch (err) {
    return { ok: false, unlisted, stale, unreadable, error: `could not list git-tracked files under ${root}: ${err.message}` }
  }
  let listed
  try {
    listed = tableFiles(readFileSync(join(root, TABLE_FILE), 'utf8'))
  } catch (err) {
    return { ok: false, unlisted, stale, unreadable, error: `could not read ${TABLE_FILE}: ${err.code ?? err.message}` }
  }

  const matched = new Set()
  for (const file of files) {
    if (!SOURCE.test(file) || NOT_SOURCE.test(file)) continue
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      unreadable.push({ file, error: err.code ?? String(err) })
      continue
    }
    const reasons = findEgress(text, file)
    if (reasons.length > 0) matched.add(file)
    if (reasons.length > 0 && !listed.has(file)) unlisted.push({ file, reasons })
  }
  for (const file of listed) if (!matched.has(file) && !unreadable.some((entry) => entry.file === file)) stale.push(file)

  unlisted.sort((a, b) => a.file.localeCompare(b.file))
  stale.sort()
  unreadable.sort((a, b) => a.file.localeCompare(b.file))
  return { ok: unlisted.length === 0 && stale.length === 0 && unreadable.length === 0, unlisted, stale, unreadable }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkEgress(process.cwd())
  if (!result.ok) {
    if (result.error !== undefined) console.error(`\n${result.error}\n\nTreating this as a failed scan, not a clean one.\n`)
    if (result.unlisted.length > 0) {
      console.error(`\nA path to the network that ${TABLE_FILE} does not list:\n`)
      for (const { file, reasons } of result.unlisted) console.error(`  ${file}  (${reasons.join('; ')})`)
      console.error(
        `\nAdd a row for each: what it reaches, what for, and how it takes the tunnel, or why it never leaves this` +
        `\ncomputer. A new way out that the tunnel does not carry is a hole in it (ADR-0080, T84).\n`
      )
    }
    if (result.stale.length > 0) {
      console.error(`\nRows in ${TABLE_FILE} for files that no longer exist:\n`)
      for (const file of result.stale) console.error(`  ${file}`)
      console.error('')
    }
    if (result.unreadable.length > 0) {
      console.error('\nFiles this guard could not read -- unknown, not clean:\n')
      for (const { file, error } of result.unreadable) console.error(`  ${file}  (${error})`)
      console.error('')
    }
    process.exit(1)
  }
  console.log(`Every path to the network in src/ is listed in ${TABLE_FILE}.`)
}
