/**
 * Fails the build if code in src/ opens a native message box or error box
 * (`dialog.showMessageBox`, `showMessageBoxSync`, `showErrorBox`) anywhere
 * but the files that may, or raises an operating-system notification
 * (Electron's `Notification`) anywhere at all.
 *
 * Every question the browser puts to the person is drawn in a panel of the
 * tab's own window (src/main/shell/question/): a native box is a separate OS
 * window with no tab to belong to, and a page cannot be told apart from the
 * browser in one. The exceptions are the question panel's own fallback for a
 * question asked before any window exists, and the start-up failure box. The
 * OS file and folder pickers are not message boxes and are not matched. A
 * notification is the same break in another form, so it has no exceptions:
 * what the browser has to say it says in the window in use (`askQuestion`).
 *
 * SCOPE: git-tracked source under src/, tests excluded. Regex over the code
 * with comments blanked, not an AST (scripts/README.md limits a guard to
 * `node:*` builtins). The name itself is matched wherever it appears, so
 * `dialog['showMessageBox']`, a destructured `{ showMessageBox }` and an
 * aliased `const box = dialog.showMessageBox` are all caught; a computed
 * `dialog[expression]` is refused outright, since it can name any method. A
 * `Notification` is matched as a named or type import (over several lines
 * too), a destructure of `require` or `import()`, a member of the module, and
 * `new Notification(`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInvokedDirectly, trackedFiles } from './cli.mjs'

/** The files that may open a native message box, each with why. */
export const ALLOWED_FILES = new Map([
  ['src/main/shell/question/ask-question.ts', 'the question panel\'s fallback, for a question asked when no shell window exists'],
  ['src/main/index.ts', 'the start-up failure box: it runs before any window exists']
])

const SOURCE = /^src\/.*\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const NOT_SOURCE = /(^|\/)tests\/|\.test\.[cm]?[jt]sx?$|\.d\.ts$/

const BOXES = /\b(?:showMessageBox|showMessageBoxSync|showErrorBox)\b/
/** `dialog[` followed by anything but a plain quoted name: a method chosen at run time. */
const COMPUTED = /\bdialog\s*(?:\?\.)?\s*\[(?!\s*(['"`])[A-Za-z]+\1\s*\])/

const FROM_ELECTRON = /['"]electron['"]/.source
/** Electron's `Notification`, however it is reached. Each can span lines, so these run over the whole text. */
const NOTIFICATIONS = [
  /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?Notification\s*\(/g,
  new RegExp(`\\{[^}]*\\bNotification\\b[^}]*\\}\\s*(?:from\\s*|=\\s*(?:await\\s+)?(?:import|require)\\s*\\(\\s*)${FROM_ELECTRON}`, 'g'),
  /\belectron\s*\.\s*Notification\b/g,
  new RegExp(`${FROM_ELECTRON}\\s*\\)\\s*\\)?\\s*\\.\\s*Notification\\b`, 'g')
]

/** The 1-based lines of `text` (comments already blanked) that reach for Electron's `Notification`. */
export function notificationLines (text) {
  const lines = new Set()
  for (const pattern of NOTIFICATIONS) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index + match[0].search(/\bNotification\b/)
      lines.add(text.slice(0, at).split('\n').length)
    }
  }
  return [...lines].sort((a, b) => a - b)
}

/**
 * The text with every comment's content replaced by spaces, keeping newlines
 * and length so a match maps back to its line. String contents are left in:
 * the scan is conservative about them, never blind.
 */
export function blankComments (text) {
  let out = ''
  let i = 0
  let quote = null
  while (i < text.length) {
    const char = text[i]
    if (quote !== null) {
      out += char
      if (char === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue }
      if (char === quote || (char === '\n' && quote !== '`')) quote = null
      i++
      continue
    }
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
    if (char === '\'' || char === '"' || char === '`') quote = char
    out += char
    i++
  }
  return out
}

/**
 * @param {string} root Directory to check, typically the repo root.
 * @param {Map<string, string>} [allowed] Files that may open a native box.
 * @returns {{ ok: boolean, offenders: Array<{file: string, line: number, text: string}>,
 *   unreadable: Array<{file: string, error: string}>, error?: string }}
 */
export function checkNativeDialogs (root, allowed = ALLOWED_FILES) {
  const offenders = []
  const unreadable = []
  let files
  try {
    files = trackedFiles(root)
  } catch (err) {
    return { ok: false, offenders, unreadable, error: `could not list git-tracked files under ${root}: ${err.message}` }
  }

  for (const file of files) {
    if (!SOURCE.test(file) || NOT_SOURCE.test(file)) continue
    const mayOpenBox = allowed.has(file)
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch (err) {
      // Tracked and unreadable: its contents are unknown, not clean.
      unreadable.push({ file, error: err.code ?? String(err) })
      continue
    }
    const blanked = blankComments(text)
    const lines = blanked.split('\n')
    if (!mayOpenBox) {
      lines.forEach((line, index) => {
        if (BOXES.test(line) || COMPUTED.test(line)) offenders.push({ file, line: index + 1, text: line.trim() })
      })
    }
    for (const line of notificationLines(blanked)) {
      if (!offenders.some((offender) => offender.file === file && offender.line === line)) offenders.push({ file, line, text: (lines[line - 1] ?? '').trim() })
    }
  }

  const byPlace = (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  offenders.sort(byPlace)
  unreadable.sort((a, b) => a.file.localeCompare(b.file))
  return { ok: offenders.length === 0 && unreadable.length === 0, offenders, unreadable }
}

if (isInvokedDirectly(import.meta.url)) {
  const result = checkNativeDialogs(process.cwd())
  if (!result.ok) {
    if (result.error !== undefined) console.error(`\n${result.error}\n\nTreating this as a failed scan, not a clean one.\n`)
    if (result.offenders.length > 0) {
      console.error('\nA native message box or an operating-system notification where none may be raised:\n')
      for (const { file, line, text } of result.offenders) console.error(`  ${file}:${line}  ${text}`)
      console.error(
        '\nAsk through askQuestion (src/main/shell/question/ask-question.ts): the question is drawn in the' +
        '\ntab\'s own window and belongs to that tab. Only the question panel\'s fallback and the start-up' +
        '\nfailure box open a native one; the OS file pickers are not matched. Nothing raises an' +
        '\noperating-system notification: say it in the window in use, the same way.\n'
      )
    }
    if (result.unreadable.length > 0) {
      console.error('\nFiles this guard could not read -- unknown, not clean:\n')
      for (const { file, error } of result.unreadable) console.error(`  ${file}  (${error})`)
      console.error('')
    }
    process.exit(1)
  }
  console.log(`No native message box outside ${[...ALLOWED_FILES.keys()].length} allowed files, and no operating-system notification.`)
}
