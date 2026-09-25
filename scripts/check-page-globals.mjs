/**
 * Fails the build if a global Orivon installs into an app's main world is
 * locked against replacement.
 *
 * ADR-0021. A page global standing in for a platform or Node global carries
 * that platform's own descriptor, so an app can replace, wrap or shadow it
 * exactly as it could in a browser. A locked one is not a small divergence:
 * strict mode forbids an own property shadowing a non-writable inherited
 * one, so a bundle using the surrogate-global pattern common to ponyfills
 * dies mid-evaluation with nothing naming the cause. The guard exists
 * because that lock arrived by copy-paste from `window.orivon`'s own,
 * deliberate lock, and the same paste is available to the next global.
 *
 * SCOPE: the directories whose code can reach a page's global object. It
 * reads descriptors on `Object.defineProperty` and nothing else --
 * `Object.freeze` is left alone, being used legitimately throughout
 * surface/main-world-socket.ts on capability objects beneath the allowlisted
 * `orivon`. Regex, not an AST, like the guards beside it: scripts/README.md
 * limits a guard to `node:*` builtins, and `typescript@7` here is the Go
 * port, whose `createSourceFile` does not exist.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, trackedFiles } from './cli.mjs'

/** Directories whose code can write to a page's global object. */
export const SCANNED_DIRECTORIES = ['src/preload/', 'src/shim/', 'src/shim-electron/', 'src/loader/']

/**
 * Names Orivon owns outright rather than borrowing from the platform. The
 * rule does not reach them: nothing tries to shadow `orivon`, the platform
 * sets no contract for its shape, and locking it costs an app nothing --
 * surface/main-world-socket.ts states that reason at the install itself.
 */
export const ORIVON_OWN_GLOBALS = new Set(['orivon', 'orivonShell', 'orivonNewTab', 'orivonSettings', 'orivonSiteInfo'])

/**
 * Identifiers that name a page's global object at an install site. A
 * descriptor on one of these must set BOTH `writable` and `configurable`
 * true explicitly, because both default to false when omitted -- writing
 * `{ value: f }` locks a global exactly as `{ writable: false }` does, and
 * the guard would be trivially evadable if it only read what was written.
 */
const GLOBAL_TARGETS = new Set(['target', 'window', 'globalThis', 'self'])

/**
 * `// orivon:locked-global -- <why>`. The reason is the whole mechanism,
 * copied from check-comments.mjs's own pragma: a bare pragma would make the
 * exemption free, and an exemption that costs nothing stops meaning anything.
 */
const PRAGMA = /orivon:locked-global/
const PRAGMA_WITH_REASON = /orivon:locked-global\s*--\s*(\S.*?)\s*$/

const SOURCE_EXTENSION = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const DECLARATION_FILE = /\.d\.ts$/
const CALL = 'Object.defineProperty('

/** True once the descriptor says so in as many words. */
const EXPLICIT_FALSE = /\b(writable|configurable)\s*:\s*false\b/
const WRITABLE_TRUE = /\bwritable\s*:\s*true\b/
const CONFIGURABLE_TRUE = /\bconfigurable\s*:\s*true\b/

/**
 * Replaces every comment's CONTENT with spaces, keeping newlines and total
 * length. Parsing then cannot be confused by a commented-out example, while
 * every offset still maps to the line it came from -- which is what lets the
 * pragma below be read off the untouched original.
 */
export function blankComments (text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const two = text.slice(i, i + 2)
    if (two === '//') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (two === '/*') {
      while (i < text.length && text.slice(i, i + 2) !== '*/') { out += text[i] === '\n' ? '\n' : ' '; i++ }
      out += '  '
      i += 2
      continue
    }
    out += text[i]
    i++
  }
  return out
}

/** The argument text between `Object.defineProperty(` and its matching `)`, or undefined if unbalanced. */
function argumentsAt (text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return undefined
}

const ARGUMENTS = /^\s*([A-Za-z_$][\w$]*)\s*,\s*(['"`])([^'"`]*)\2\s*,\s*([\s\S]*)$/

/**
 * Whether this call locks a global, given its target, property name and
 * descriptor text. Two independent triggers, because a lock can be written
 * either way round: an explicit `false` anywhere in these directories, or a
 * descriptor on a global target that fails to say `true` for both.
 */
function violation (targetName, propName, descriptor) {
  if (ORIVON_OWN_GLOBALS.has(propName)) return undefined
  if (EXPLICIT_FALSE.test(descriptor)) return 'the descriptor locks it explicitly'
  if (!GLOBAL_TARGETS.has(targetName)) return undefined
  if (WRITABLE_TRUE.test(descriptor) && CONFIGURABLE_TRUE.test(descriptor)) return undefined
  return 'a descriptor on a global must set writable and configurable true explicitly; both default to false'
}

/** The pragma governing the call at `line`, read off the unmodified source: `undefined` (none), `null` (no reason), or the reason. */
function pragmaAbove (lines, line) {
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i] ?? ''
    if (PRAGMA.test(text)) return PRAGMA_WITH_REASON.exec(text)?.[1] ?? null
    const trimmed = text.trim()
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    return undefined
  }
  return undefined
}

/**
 * @param {string} root Directory to check, typically the repo root.
 * @returns {{ ok: boolean, offenders: Array<{file: string, line: number, property: string, reason: string}>,
 *   unjustified: Array<{file: string, line: number, property: string}>,
 *   exempted: Array<{file: string, line: number, property: string, reason: string}>,
 *   unparsed: Array<{file: string, line: number}>,
 *   unreadable: Array<{file: string, error: string}>, error?: string }}
 *   Every array sorted by path then line. `unparsed` is a call this guard
 *   could not read -- a computed property name, an unbalanced paren -- and
 *   it FAILS, because a call it cannot read is one it cannot clear.
 */
export function checkPageGlobals (root) {
  const offenders = []
  const unjustified = []
  const exempted = []
  const unparsed = []
  const unreadable = []

  let files
  try {
    files = trackedFiles(root)
  } catch (err) {
    return {
      ok: false,
      offenders,
      unjustified,
      exempted,
      unparsed,
      unreadable,
      error: `could not list git-tracked files under ${root}: ${err.message}`
    }
  }

  for (const file of files) {
    if (!SCANNED_DIRECTORIES.some((dir) => file.startsWith(dir))) continue
    if (DECLARATION_FILE.test(file) || !SOURCE_EXTENSION.test(file)) continue

    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      // Tracked by git and unreadable -- absent from the filesystem, or the
      // permissions deny it. Either way its install sites are unknown, not
      // absent, so it fails rather than reading as clean. (check-size.mjs
      // forgives ENOENT because it walks the filesystem, where a file can
      // genuinely race out from under readdirSync; a git-listed file that is
      // not there is a different thing, and check-comments.mjs, which lists
      // the same way this does, fails on it too.)
      unreadable.push({ file, error: err.code ?? String(err) })
      continue
    }

    const blanked = blankComments(text)
    const lines = text.split('\n')

    for (let at = blanked.indexOf(CALL); at !== -1; at = blanked.indexOf(CALL, at + 1)) {
      const open = at + CALL.length - 1
      const line = blanked.slice(0, at).split('\n').length
      const args = argumentsAt(blanked, open)
      const parsed = args === undefined ? null : ARGUMENTS.exec(args)
      if (parsed === null) {
        unparsed.push({ file, line })
        continue
      }

      const [, targetName, , property, descriptor] = parsed
      const reason = violation(targetName, property, descriptor)
      if (reason === undefined) continue

      const pragma = pragmaAbove(lines, line)
      if (pragma === undefined) offenders.push({ file, line, property, reason })
      else if (pragma === null) unjustified.push({ file, line, property })
      else exempted.push({ file, line, property, reason: pragma })
    }
  }

  const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  offenders.sort(byPlace)
  unjustified.sort(byPlace)
  exempted.sort(byPlace)
  unparsed.sort(byPlace)
  unreadable.sort((a, b) => a.file.localeCompare(b.file))

  return {
    ok: offenders.length === 0 && unjustified.length === 0 && unparsed.length === 0 && unreadable.length === 0,
    offenders,
    unjustified,
    exempted,
    unparsed,
    unreadable
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkPageGlobals(process.cwd())

  if (!result.ok) {
    if (result.error !== undefined) {
      console.error(`\n${result.error}\n\nTreating this as a failed scan, not a clean one.\n`)
    }

    if (result.offenders.length > 0) {
      console.error('\nPage globals locked against replacement (ADR-0021):\n')
      for (const { file, line, property, reason } of result.offenders) {
        console.error(`  ${file}:${line}  ${property} -- ${reason}`)
      }
      console.error(
        '\nAn app must be able to replace, wrap or shadow one of these exactly as it could in a' +
        '\nbrowser. Strict mode forbids shadowing a non-writable inherited property, so a locked' +
        '\none kills any bundle that ponyfills it -- with no error naming the cause. Give it' +
        "\n`writable: true, configurable: true`, or justify it with the pragma below.\n"
      )
    }

    if (result.unjustified.length > 0) {
      console.error('\nA locked global exempted with no reason given:\n')
      for (const { file, line, property } of result.unjustified) {
        console.error(`  ${file}:${line}  ${property}`)
      }
      console.error('\nWrite `// orivon:locked-global -- <why this one cannot carry the platform\'s' +
        "\ndescriptor>`. A bare pragma would make the exemption free, and an exemption that costs" +
        '\nnothing stops meaning anything.\n')
    }

    if (result.unparsed.length > 0) {
      console.error('\nObject.defineProperty calls this guard could not read -- a computed property' +
        '\nname, or an unbalanced paren. A call it cannot read is one it cannot clear:\n')
      for (const { file, line } of result.unparsed) console.error(`  ${file}:${line}`)
      console.error('\nSpell the property name as a literal, or move the call out of these' +
        ` directories\n(${SCANNED_DIRECTORIES.join(', ')}).\n`)
    }

    if (result.unreadable.length > 0) {
      console.error('\nFiles this guard could not read -- unknown, not clean, so this fails rather' +
        ' than passing silently:\n')
      for (const { file, error } of result.unreadable) console.error(`  ${file}  (${error})`)
      console.error('')
    }

    process.exit(1)
  }

  const exempt = result.exempted.length
  console.log(`Every page global carries a descriptor an app can replace${exempt > 0 ? ` (${exempt} justified exemption${exempt === 1 ? '' : 's'})` : ''}.`)
}
