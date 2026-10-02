// The guard's own tests. It exists to keep every question the browser asks inside the tab's own window, and the
// ways someone would route around it -- bracket access, a destructured import, an alias, hiding the call in a
// comment, a method chosen at run time -- each get a test of their own: a guard that only catches the obvious
// spelling catches nothing a copy-paste would not have written differently.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALLOWED_FILES, blankComments, checkNativeDialogs } from '../check-native-dialogs.mjs'

/** A git repo whose tracked files are exactly those given. */
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-native-dialogs-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

const offenders = (files: Record<string, string>) => checkNativeDialogs(repo(files)).offenders.map((o) => `${o.file}:${o.line}`)

describe('what it refuses', () => {
  it('fails a stray showMessageBox in src/main', () => {
    const result = checkNativeDialogs(repo({ 'src/main/foo.ts': 'import { dialog } from \'electron\'\nawait dialog.showMessageBox({ message: \'x\' })\n' }))
    expect(result.ok).toBe(false)
    expect(result.offenders).toEqual([{ file: 'src/main/foo.ts', line: 2, text: 'await dialog.showMessageBox({ message: \'x\' })' }])
  })

  it.each([
    ['the sync form', 'dialog.showMessageBoxSync(win, {})'],
    ['the error box', 'dialog.showErrorBox(\'t\', \'c\')'],
    ['bracket access', 'dialog[\'showMessageBox\']({})'],
    ['bracket access with double quotes', 'dialog["showMessageBoxSync"]({})'],
    ['optional chaining', 'dialog?.showMessageBox({})'],
    ['a destructured import', 'const { showMessageBox } = dialog'],
    ['a destructure that renames', 'const { showMessageBox: box } = dialog'],
    ['an alias', 'const box = dialog.showMessageBox'],
    ['a method chosen at run time', 'dialog[method]({})'],
    ['a spread of a computed key', 'dialog[`show${kind}`]({})']
  ])('catches %s', (_name, line) => {
    expect(offenders({ 'src/main/a.ts': `${line}\n` })).toEqual(['src/main/a.ts:1'])
  })

  it('catches it in any directory of src', () => {
    expect(offenders({ 'src/broker/transport/a.ts': 'dialog.showMessageBox({})\n', 'src/renderer/b.ts': 'dialog.showErrorBox(\'a\', \'b\')\n' }))
      .toEqual(['src/broker/transport/a.ts:1', 'src/renderer/b.ts:1'])
  })

  it('catches a call that follows a string holding two slashes on the same line', () => {
    expect(offenders({ 'src/main/a.ts': 'const u = \'https://x.example\'; dialog.showMessageBox({})\n' })).toEqual(['src/main/a.ts:1'])
  })
})

describe('what it allows', () => {
  it('passes the allowlisted files', () => {
    const files = Object.fromEntries([...ALLOWED_FILES.keys()].map((name) => [name, 'dialog.showMessageBox({})\n']))
    expect(checkNativeDialogs(repo(files))).toEqual({ ok: true, offenders: [], unreadable: [] })
  })

  it('does not match the OS file pickers', () => {
    expect(offenders({ 'src/main/a.ts': 'await dialog.showOpenDialog({})\nawait dialog.showSaveDialog(win, {})\n' })).toEqual([])
  })

  it('does not match a comment that names it', () => {
    expect(offenders({
      'src/main/a.ts': '// dialog.showMessageBox is not used here\n/* dialog.showErrorBox\n   dialog.showMessageBoxSync */\nconst x = 1 // dialog.showMessageBox\n'
    })).toEqual([])
  })

  it('skips tests and declaration files', () => {
    expect(offenders({
      'src/main/tests/a.test.ts': 'dialog.showMessageBox({})\n',
      'src/main/b.test.ts': 'dialog.showMessageBox({})\n',
      'src/main/c.d.ts': 'declare const showMessageBox: unknown\n'
    })).toEqual([])
  })

  it('does not scan outside src', () => {
    expect(offenders({ 'scripts/a.mjs': 'dialog.showMessageBox({})\n', 'test/b.ts': 'dialog.showMessageBox({})\n' })).toEqual([])
  })

  it('passes a clean tree', () => {
    expect(checkNativeDialogs(repo({ 'src/main/a.ts': 'export const a = 1\n' }))).toEqual({ ok: true, offenders: [], unreadable: [] })
  })
})

describe('failing safe', () => {
  it('fails when the directory is not a git tree, rather than reading it as clean', () => {
    const result = checkNativeDialogs(mkdtempSync(join(tmpdir(), 'orivon-not-git-')))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not list/)
  })
})

describe('blankComments', () => {
  it('keeps line numbers and leaves strings alone', () => {
    const out = blankComments('a // b\n/* c\nd */ e\n\'//x\'')
    expect(out.split('\n')).toHaveLength(4)
    expect(out).toContain('\'//x\'')
    expect(out).not.toContain('b')
  })
})
