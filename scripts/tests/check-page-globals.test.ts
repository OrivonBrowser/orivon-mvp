// The guard's own tests. It exists to stop a page global being locked
// against replacement (ADR-0021), and the ways someone would route around it
// -- omitting `writable` rather than writing `false`, naming the property
// through a variable, hiding the call in a comment -- each get a test of
// their own, because a guard that only catches the obvious spelling catches
// nothing a copy-paste would not have written differently.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPageGlobals, ORIVON_OWN_GLOBALS, SCANNED_DIRECTORIES } from '../check-page-globals.mjs'

/** A git repo whose tracked files are exactly those given. */
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-page-globals-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

/** One install site in a scanned directory, as the only content of a file. */
const install = (descriptor: string, target = 'target', property = "'fetch'"): string =>
  `export function installX (target: unknown): void {\n  Object.defineProperty(${target}, ${property}, ${descriptor})\n}\n`

const PLATFORM = '{ value: f, writable: true, configurable: true, enumerable: true }'
const LOCKED = '{ value: f, writable: false, configurable: false, enumerable: true }'

const CLEAN = { ok: true, offenders: [], unjustified: [], exempted: [], unparsed: [], unreadable: [] }

describe('the rule', () => {
  it('passes a global carrying the platform\'s own descriptor', () => {
    expect(checkPageGlobals(repo({ 'src/preload/a.ts': install(PLATFORM) }))).toEqual(CLEAN)
  })

  it('fails a global the descriptor locks in as many words', () => {
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': install(LOCKED) }))
    expect(result.ok).toBe(false)
    expect(result.offenders).toEqual([
      { file: 'src/preload/a.ts', line: 2, property: 'fetch', reason: 'the descriptor locks it explicitly' }
    ])
  })

  it('fails a global that merely OMITS writable, since it defaults to false', () => {
    // The evasion a guard reading only what was written would miss:
    // `{ value: f }` locks exactly as `{ writable: false }` does.
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': install('{ value: f, enumerable: true }') }))
    expect(result.ok).toBe(false)
    expect(result.offenders[0]?.reason).toMatch(/default to false/)
  })

  it('leaves a non-global target alone when it merely omits writable', () => {
    // Function.prototype.name is { writable: false, configurable: true } in
    // the platform itself, and src/shim-electron/unimplemented.ts restores
    // exactly that. Flagging it would make the guard wrong, not strict.
    const source = install('{ value: prop, configurable: true }', 'fn', "'name'")
    expect(checkPageGlobals(repo({ 'src/shim-electron/a.ts': source }))).toEqual(CLEAN)
  })

  it.each([...ORIVON_OWN_GLOBALS])('leaves %s alone -- Orivon owns the name, the platform sets no contract for it', (name) => {
    const source = install(LOCKED, 'target', `'${name}'`)
    expect(checkPageGlobals(repo({ 'src/preload/a.ts': source }))).toEqual(CLEAN)
  })

  it.each(['window', 'globalThis', 'self'])('recognises %s as a page global, not only `target`', (global) => {
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': install('{ value: f }', global) }))
    expect(result.ok).toBe(false)
  })
})

describe('the escape hatch', () => {
  const pragma = (comment: string): string =>
    `export function installX (target: unknown): void {\n  ${comment}\n  Object.defineProperty(target, 'fetch', ${LOCKED})\n}\n`

  it('exempts a lock whose pragma gives a reason', () => {
    const source = pragma('// orivon:locked-global -- the platform locks this one too')
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': source }))
    expect(result.ok).toBe(true)
    expect(result.exempted).toEqual([
      { file: 'src/preload/a.ts', line: 3, property: 'fetch', reason: 'the platform locks this one too' }
    ])
  })

  it('fails a bare pragma, because an exemption that costs nothing stops meaning anything', () => {
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': pragma('// orivon:locked-global') }))
    expect(result.ok).toBe(false)
    expect(result.unjustified).toEqual([{ file: 'src/preload/a.ts', line: 3, property: 'fetch' }])
    expect(result.offenders).toEqual([])
  })

  it('finds a pragma sitting above an intervening comment block', () => {
    const source =
      "export function installX (target: unknown): void {\n" +
      "  // orivon:locked-global -- stated once, at the top of the block\n" +
      "  // Everything below is ordinary prose about the line that follows,\n" +
      "  // and must not hide the pragma from the guard.\n" +
      `  Object.defineProperty(target, 'fetch', ${LOCKED})\n}\n`
    expect(checkPageGlobals(repo({ 'src/preload/a.ts': source })).ok).toBe(true)
  })

  it('does not let a pragma from an earlier, unrelated call carry down past real code', () => {
    const source =
      "export function installX (target: unknown): void {\n" +
      "  // orivon:locked-global -- belongs to the call on the next line only\n" +
      `  Object.defineProperty(target, 'orivon', ${LOCKED})\n` +
      "  const f = () => undefined\n" +
      `  Object.defineProperty(target, 'fetch', ${LOCKED})\n}\n`
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': source }))
    expect(result.ok).toBe(false)
    expect(result.offenders.map((o) => o.property)).toEqual(['fetch'])
  })
})

describe('what it reads', () => {
  it('ignores a call that is only an example inside a comment', () => {
    const source =
      "// A worked example of what NOT to write:\n" +
      `//   Object.defineProperty(target, 'fetch', ${LOCKED})\n` +
      install(PLATFORM)
    expect(checkPageGlobals(repo({ 'src/preload/a.ts': source })).ok).toBe(true)
  })

  it('ignores a call inside a block comment, and still reports later lines correctly', () => {
    const source =
      `/*\n  Object.defineProperty(target, 'fetch', ${LOCKED})\n*/\n` +
      install(LOCKED)
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': source }))
    expect(result.offenders).toEqual([
      { file: 'src/preload/a.ts', line: 5, property: 'fetch', reason: 'the descriptor locks it explicitly' }
    ])
  })

  it('reads a call spread over several lines', () => {
    const source =
      "export function installX (target: unknown): void {\n" +
      "  Object.defineProperty(\n    target,\n    'fetch',\n    { value: f, writable: false }\n  )\n}\n"
    expect(checkPageGlobals(repo({ 'src/preload/a.ts': source })).ok).toBe(false)
  })

  it.each(SCANNED_DIRECTORIES)('scans %s', (dir) => {
    expect(checkPageGlobals(repo({ [`${dir}a.ts`]: install(LOCKED) })).ok).toBe(false)
  })

  it('leaves directories that cannot reach a page global alone', () => {
    // src/broker/ runs in the main process; it has no page to install onto,
    // and a lock there is an ordinary object being frozen.
    expect(checkPageGlobals(repo({ 'src/broker/a.ts': install(LOCKED) }))).toEqual(CLEAN)
  })

  it('ignores a .d.ts, which is ambient rather than authored against this rule', () => {
    expect(checkPageGlobals(repo({ 'src/preload/a.d.ts': install(LOCKED) }))).toEqual(CLEAN)
  })
})

describe('bypass resistance', () => {
  it('fails a property named through a variable rather than a literal', () => {
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': install(LOCKED, 'target', 'NAME') }))
    expect(result.ok).toBe(false)
    expect(result.unparsed).toEqual([{ file: 'src/preload/a.ts', line: 2 }])
  })

  it('fails an unbalanced call rather than skipping it', () => {
    const source = "export function installX (target: unknown): void {\n  Object.defineProperty(target, 'fetch', { value: f\n"
    const result = checkPageGlobals(repo({ 'src/preload/a.ts': source }))
    expect(result.ok).toBe(false)
    expect(result.unparsed).toEqual([{ file: 'src/preload/a.ts', line: 2 }])
  })
})

describe('reporting', () => {
  it('reports a tracked file it cannot read rather than passing it silently', () => {
    // Tracked by git, absent from the filesystem: its install sites are
    // unknown, not absent, so it must not read as compliant.
    const root = repo({ 'src/preload/gone.ts': install(PLATFORM) })
    rmSync(join(root, 'src/preload/gone.ts'))
    const result = checkPageGlobals(root)
    expect(result.ok).toBe(false)
    expect(result.unreadable.map((u) => u.file)).toEqual(['src/preload/gone.ts'])
  })

  it('reports a file the permissions deny', () => {
    const root = repo({ 'src/preload/shut.ts': install(PLATFORM) })
    chmodSync(join(root, 'src/preload/shut.ts'), 0o000)
    const result = checkPageGlobals(root)
    chmodSync(join(root, 'src/preload/shut.ts'), 0o644)
    expect(result.ok).toBe(false)
    expect(result.unreadable.map((u) => u.file)).toEqual(['src/preload/shut.ts'])
  })

  it('fails loudly on a non-git directory instead of reporting clean', () => {
    // A git failure must never read the same as "nothing to check": a locked
    // global in a git-less copy would otherwise pass.
    const root = mkdtempSync(join(tmpdir(), 'orivon-page-globals-nogit-'))
    const result = checkPageGlobals(root)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/could not list git-tracked files/)
  })

  it('sorts every report by path, then by line', () => {
    const two = install(LOCKED) + install(LOCKED, 'target', "'process'")
    const result = checkPageGlobals(repo({ 'src/shim/b.ts': two, 'src/preload/a.ts': install(LOCKED) }))
    expect(result.offenders.map((o) => `${o.file}:${o.line}`)).toEqual([
      'src/preload/a.ts:2', 'src/shim/b.ts:2', 'src/shim/b.ts:5'
    ])
  })
})
