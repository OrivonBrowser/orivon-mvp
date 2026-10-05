import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CATALOGUE, CI_WORKFLOW, CONTRACT, capabilityKinds, checkCatalogue, findSuiteSwitches, findTests, findUnrecordedChanges, jobText, parseCatalogue, parseCoverage
} from '../check-app-behaviours.mjs'

const HEADER = '| Id | Behaviour | Apps | Ports | Proven by |\n|---|---|---|---|---|\n'
const row = (id: string, proven: string, behaviour = 'It works.'): string => `| \`${id}\` | ${behaviour} | wallets | - | ${proven} |\n`
const spec = (name: string): string => `[\`test/${name}\`](../../test/${name})`

/** A contract that declares no capability kind, so a catalogue under test needs no coverage table. */
const NO_KINDS = 'export type CapabilityKind = never\n'
const kindsOf = (...kinds: string[]): string => `export type CapabilityKind =\n${kinds.map((kind) => `  /** doc */\n  | '${kind}'`).join('\n')}\n\nexport interface Next {}\n`

const WORKFLOW = [
  'jobs:',
  '  e2e:',
  '    steps:',
  '      - run: npx vitest run test/e2e-plain.test.ts',
  `  ${'e2e-ordinary'}:`,
  '    steps:',
  '      - run: npx vitest run test/e2e-ordinary.test.ts',
  '  other:',
  '    steps: []',
  ''
].join('\n')

/** A scratch repository holding a catalogue, a workflow and the given files. */
const fixture = (catalogue: string, files: Record<string, string> = {}, workflow = WORKFLOW): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-behaviours-'))
  const all: Record<string, string> = { [CATALOGUE]: catalogue, [CI_WORKFLOW]: workflow, [CONTRACT]: NO_KINDS, ...files }
  for (const [path, body] of Object.entries(all)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

const PROVING = (id: string, modifiers = ''): string => `import { it } from 'vitest'\nit${modifiers}(\n  '[app:${id}] does the thing',\n  async () => {}\n)\n`

describe('parseCatalogue', () => {
  it('reads a row into its five cells and the specs named in the last one', () => {
    const { entries, problems } = parseCatalogue(HEADER + row('data-survives-restart', `${spec('e2e-a.test.ts')}, ${spec('e2e-b.test.ts')}`))
    expect(problems).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'data-survives-restart', specs: ['test/e2e-a.test.ts', 'test/e2e-b.test.ts'], covered: true })
  })

  it('skips header, separator and prose lines', () => {
    expect(parseCatalogue(`# Title\n\n${HEADER}text | with a bar\n`).entries).toEqual([])
  })

  it('accepts "not covered" with a reason and rejects it without one', () => {
    expect(parseCatalogue(row('a-b', 'not covered: the port serves it')).problems).toEqual([])
    expect(parseCatalogue(row('a-b', 'not covered:')).problems.join()).toContain('names no spec')
  })

  it('flags a bad id, a duplicate id, a wrong column count and an empty behaviour', () => {
    const { problems } = parseCatalogue(row('Bad_Id', 'not covered: x') + row('dup', 'not covered: x') + row('dup', 'not covered: x') + '| `short` | only | three |\n' + row('empty', 'not covered: x', ''))
    expect(problems.join('\n')).toContain('not a kebab-case id')
    expect(problems.join('\n')).toContain('already an entry at line 2')
    expect(problems.join('\n')).toContain('has 3 columns')
    expect(problems.join('\n')).toContain('states no behaviour')
  })

  it('does not let a unit test prove an entry on its own', () => {
    const { problems } = parseCatalogue(row('a-b', '[`x`](../../src/broker/tests/x.test.ts)'))
    expect(problems.join()).toContain('proven by no e2e spec')
  })
})

describe('findTests', () => {
  it('reads plain, gated, skipped and template-string titles with their modifiers and lines', () => {
    const source = [
      "it('plain', () => {})",
      "it.skipIf(!ORDINARY_BUILD)(",
      "  'gated',",
      '  async () => {}',
      ')',
      "test.skip('off', () => {})",
      'it(`tpl`, () => {})'
    ].join('\n')
    expect(findTests(source)).toEqual([
      { title: 'plain', modifiers: '', line: 1, dynamic: false },
      { title: 'gated', modifiers: '.skipIf(!ORDINARY_BUILD)', line: 3, dynamic: false },
      { title: 'off', modifiers: '.skip', line: 6, dynamic: false },
      { title: 'tpl', modifiers: '', line: 7, dynamic: false }
    ])
  })

  it('keeps a nested call inside a skipIf condition as one modifier', () => {
    expect(findTests("it.skipIf(!existsSync(join(a, 'b')))('x', () => {})")[0]?.modifiers).toBe(".skipIf(!existsSync(join(a, 'b')))")
  })

  it('does not count a call inside a comment or a string, or flags an interpolating title', () => {
    const source = [
      "// it('[app:a] in a line comment', () => {})",
      "/* it('[app:b] in a block comment', () => {}) */",
      "const text = \"it('[app:c] in a string', () => {})\"",
      "it('[app:d] real', () => {})",
      "it(`[app:e] ${x ? 'a' : 'b'} templated`, () => {})"
    ].join('\n')
    expect(findTests(source).map((t) => [t.title.slice(0, 9), t.dynamic])).toEqual([['[app:d] r', false], ['[app:e] $', true]])
  })

  it('finds a suite-level switch', () => {
    expect(findSuiteSwitches("describe.skip('x', () => {})\ndescribe('y', () => {})")).toEqual(['describe.skip'])
  })
})

describe('jobText', () => {
  it('returns the named job and stops at the next', () => {
    expect(jobText(WORKFLOW)).toContain('e2e-ordinary.test.ts')
    expect(jobText(WORKFLOW)).not.toContain('e2e-plain')
    expect(jobText(WORKFLOW)).not.toContain('other:')
    expect(jobText('jobs:\n  e2e:\n')).toBe('')
    expect(jobText('jobs:\n  e2e-ordinary:\n    steps:\n      # test/e2e-x.test.ts\n      - run: x # test/e2e-y.test.ts\n')).not.toMatch(/e2e-[xy]\.test/)
  })
})

describe('checkCatalogue', () => {
  it('passes when the named spec has a test titled with the id', () => {
    const root = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), { 'test/e2e-plain.test.ts': PROVING('a-b') })
    expect(checkCatalogue(root)).toMatchObject({ ok: true, problems: [] })
  })

  it('fails when the spec is missing, or has no test titled with the id', () => {
    const missing = fixture(HEADER + row('a-b', spec('e2e-gone.test.ts')))
    expect(checkCatalogue(missing).problems.join()).toContain('does not exist')
    const untitled = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), { 'test/e2e-plain.test.ts': PROVING('other-id') })
    expect(checkCatalogue(untitled).problems.join('\n')).toContain('no test is titled with [app:a-b]')
  })

  it('fails a proving test CI skips, narrows or switches off', () => {
    for (const modifiers of ['.skip', '.todo', '.only', '.skipIf(!BUILT)', '.runIf(X)']) {
      const root = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), { 'test/e2e-plain.test.ts': PROVING('a-b', modifiers) })
      expect(checkCatalogue(root).problems.join(), modifiers).toContain('proves nothing')
    }
    const suite = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), { 'test/e2e-plain.test.ts': `describe.skip('x', () => {})\n${PROVING('a-b')}` })
    expect(checkCatalogue(suite).problems.join()).toContain('describe.skip')
  })

  it('lets an ordinary-build gate through only for a spec the ordinary job runs', () => {
    const gated = PROVING('a-b', '.skipIf(!ORDINARY_BUILD)')
    const runs = fixture(HEADER + row('a-b', spec('e2e-ordinary.test.ts')), { 'test/e2e-ordinary.test.ts': gated })
    expect(checkCatalogue(runs)).toMatchObject({ ok: true })
    const absent = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), { 'test/e2e-plain.test.ts': gated })
    expect(checkCatalogue(absent).problems.join()).toContain('does not run test/e2e-plain.test.ts')
  })

  it('does not let a commented-out, interpolated or unit-only test stand as proof', () => {
    const catalogue = HEADER + row('a-b', spec('e2e-plain.test.ts'))
    const commented = fixture(catalogue, { 'test/e2e-plain.test.ts': "// it('[app:a-b] gone', () => {})\n" })
    expect(checkCatalogue(commented).problems.join()).toContain('no test is titled with [app:a-b]')
    const templated = fixture(catalogue, { 'test/e2e-plain.test.ts': "it(`[app:a-b] ${'x'}`, () => {})\n" })
    expect(checkCatalogue(templated).problems.join()).toContain('interpolates')
  })

  it('lists a unit test beside the e2e spec without asking it for a marker', () => {
    const rowBoth = HEADER + row('a-b', `${spec('e2e-plain.test.ts')}, [\`unit\`](../../src/x/tests/unit.test.ts)`)
    const root = fixture(rowBoth, { 'test/e2e-plain.test.ts': PROVING('a-b'), 'src/x/tests/unit.test.ts': "it('plain unit', () => {})\n" })
    expect(checkCatalogue(root)).toMatchObject({ ok: true })
  })

  it('fails a marker the catalogue lacks, anywhere under test/, src/ or scripts/tests/', () => {
    const root = fixture(HEADER + row('a-b', spec('e2e-plain.test.ts')), {
      'test/e2e-plain.test.ts': PROVING('a-b'),
      'src/broker/note.ts': '// [app:ghost-id] left behind\n',
      'test/apps/x/page.js': '// [app:ignored-fixture]\n'
    })
    const { problems } = checkCatalogue(root)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/broker/note.ts:1: [app:ghost-id] is not an entry')
  })

  it('reports an unreadable catalogue and an empty one as failures', () => {
    const root = fixture('# nothing\n')
    expect(checkCatalogue(root).problems.join()).toContain('holds no entry')
    expect(checkCatalogue(join(root, 'nowhere')).ok).toBe(false)
  })
})

describe('findUnrecordedChanges', () => {
  const base = HEADER + row('keep', 'not covered: x', 'Stays.') + row('edit', 'not covered: x', 'Before.') + row('drop', 'not covered: x')
  const log = (lines: string[]): string => `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- x\n\n${lines.length === 0 ? '' : `### Changed for apps\n\n${lines.join('\n')}\n\n`}## [0.1.0]\n\n### Changed for apps\n\n- **\`edit\`**: old.\n`

  it('names a changed or removed entry that has no record', () => {
    const head = HEADER + row('keep', 'not covered: x', 'Stays.') + row('edit', 'not covered: x', 'After.')
    expect(findUnrecordedChanges({ baseCatalogue: base, headCatalogue: head, baseChangelog: log([]), headChangelog: log([]) }))
      .toEqual([{ id: 'edit', why: 'changed' }, { id: 'drop', why: 'removed' }])
  })

  it('accepts a line added under Changed for apps that names the id, and not an old one', () => {
    const head = HEADER + row('keep', 'not covered: x', 'Stays.') + row('edit', 'not covered: x', 'After.')
    const recorded = log(['- **`edit`**: now After. Apps must do Z. Recheck: Element.', '- **`drop`**: gone. Apps must do W.'])
    expect(findUnrecordedChanges({ baseCatalogue: base, headCatalogue: head, baseChangelog: log([]), headChangelog: recorded })).toEqual([])
    const stale = log(['- **`edit`**: already there.'])
    expect(findUnrecordedChanges({ baseCatalogue: base, headCatalogue: head, baseChangelog: stale, headChangelog: stale }).map((u) => u.id)).toEqual(['edit', 'drop'])
  })

  it('names a row that was proven and is now not covered', () => {
    const proven = HEADER + row('keep', spec('e2e-a.test.ts'), 'Stays.')
    const weakened = HEADER + row('keep', 'not covered: the spec went', 'Stays.')
    expect(findUnrecordedChanges({ baseCatalogue: proven, headCatalogue: weakened, baseChangelog: log([]), headChangelog: log([]) }))
      .toEqual([{ id: 'keep', why: 'no longer proven' }])
  })

  it('needs no record for a new entry, or for a changed port list or proof', () => {
    const head = base.replace('| wallets | - |', '| wallets | Element |') + row('fresh', 'not covered: x')
    expect(findUnrecordedChanges({ baseCatalogue: base, headCatalogue: head, baseChangelog: log([]), headChangelog: log([]) })).toEqual([])
  })

  it('ignores differences in whitespace inside the behaviour sentence', () => {
    const head = base.replace('Before.', 'Before.  ')
    expect(findUnrecordedChanges({ baseCatalogue: base, headCatalogue: head, baseChangelog: log([]), headChangelog: log([]) })).toEqual([])
  })
})

describe('capabilityKinds', () => {
  it('reads the members of the union, skipping comments, and stops at the next declaration', () => {
    expect(capabilityKinds(kindsOf('tcp.connect', 'fs'))).toEqual(['tcp.connect', 'fs'])
    expect(capabilityKinds('export type Other = 1\n')).toEqual([])
  })
})

describe('parseCoverage', () => {
  it('reads each backticked kind with the ids that prove it, or its not-covered reason', () => {
    const text = '# t\n\n## Capability coverage\n\n| Capability | Rows |\n|---|---|\n| `fs` | `a-b`, `c-d` |\n| `id` | not covered: nothing relies on `x-y` yet |\n'
    expect(parseCoverage(text)).toEqual([
      { kind: 'fs', ids: ['a-b', 'c-d'], covered: true, line: 7 },
      { kind: 'id', ids: [], covered: false, line: 8 }
    ])
    expect(parseCoverage('no table')).toEqual([])
  })
})

describe('capability coverage in checkCatalogue', () => {
  const rows = HEADER + row('a-b', spec('e2e-plain.test.ts'))
  const proving = { 'test/e2e-plain.test.ts': PROVING('a-b') }
  const table = (lines: string[]): string => `\n## Capability coverage\n\n| Capability | Rows |\n|---|---|\n${lines.join('\n')}\n`

  it('passes when every kind has a line naming rows or a reason', () => {
    const root = fixture(rows + table(['| `fs` | `a-b` |', '| `id` | not covered: nothing relies on it |']), { ...proving, [CONTRACT]: kindsOf('fs', 'id') })
    expect(checkCatalogue(root)).toMatchObject({ ok: true, problems: [] })
  })

  it('fails a capability the contract declares and the catalogue has no line for', () => {
    const root = fixture(rows + table(['| `fs` | `a-b` |']), { ...proving, [CONTRACT]: kindsOf('fs', 'tcp.connect') })
    expect(checkCatalogue(root).problems.join('\n')).toContain('declares the capability `tcp.connect`')
  })

  it('fails a line for a kind that does not exist, a row that does not exist, a bare line and a repeated kind', () => {
    const root = fixture(rows + table(['| `ghost` | `a-b` |', '| `fs` | `no-such-row` |', '| `id` | |', '| `id` | `a-b` |']), { ...proving, [CONTRACT]: kindsOf('fs', 'id') })
    const joined = checkCatalogue(root).problems.join('\n')
    expect(joined).toContain('`ghost` is not a capability kind')
    expect(joined).toContain('names `no-such-row`')
    expect(joined).toContain('`id` names no row')
    expect(joined).toContain('`id` has two lines')
  })

  it('does not read the coverage table as catalogue rows', () => {
    const root = fixture(rows + table(['| `fs` | `a-b` |']), { ...proving, [CONTRACT]: kindsOf('fs') })
    expect(checkCatalogue(root).entries.map((entry) => entry.id)).toEqual(['a-b'])
  })

  it('fails when the contract cannot be read', () => {
    const root = fixture(rows, proving)
    rmSync(join(root, CONTRACT))
    expect(checkCatalogue(root).problems.join()).toContain(`could not read ${CONTRACT}`)
  })
})
