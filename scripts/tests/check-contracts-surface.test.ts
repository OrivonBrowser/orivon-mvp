import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CONTRACTS_DIR, SNAPSHOT, checkSurface, findUnrecordedSurfaceChanges, sectionsOf, stripComments, surfaceOf } from '../check-contracts-surface.mjs'

const fixture = (files: Record<string, string>, snapshot?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-surface-'))
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, CONTRACTS_DIR), { recursive: true })
    writeFileSync(join(root, CONTRACTS_DIR, name), source)
  }
  if (snapshot !== undefined) {
    mkdirSync(dirname(join(root, SNAPSHOT)), { recursive: true })
    writeFileSync(join(root, SNAPSHOT), snapshot)
  }
  return root
}

describe('stripComments', () => {
  it('removes block and line comments and keeps the code', () => {
    expect(stripComments('/** doc */\nexport const A = 1 // why\n/* x */export type B = 2')).toBe('\nexport const A = 1 \nexport type B = 2')
  })

  it('leaves comment-like text inside a string alone', () => {
    expect(stripComments("export const URL = 'http://x/*y*/' // trailing")).toBe("export const URL = 'http://x/*y*/' ")
    expect(stripComments('const t = `a // b ${c}`')).toBe('const t = `a // b ${c}`')
  })

  it('handles an escaped quote and an unterminated block comment', () => {
    expect(stripComments("const s = 'it\\'s // fine'")).toBe("const s = 'it\\'s // fine'")
    expect(stripComments('const a = 1 /* never closed')).toBe('const a = 1 ')
  })
})

describe('surfaceOf and sectionsOf', () => {
  it('writes one section per file with blank lines and trailing space dropped, and reads them back', () => {
    const text = surfaceOf([{ name: 'a.ts', source: '// c\nexport const A = 1  \n\n' }, { name: 'b.ts', source: 'export type B = 2\n' }])
    expect(text).toBe('== a.ts\nexport const A = 1\n== b.ts\nexport type B = 2\n')
    expect([...sectionsOf(text)]).toEqual([['a.ts', 'export const A = 1\n'], ['b.ts', 'export type B = 2\n']])
  })

  it('does not change when only a comment is reworded', () => {
    const before = surfaceOf([{ name: 'a.ts', source: '/** old words */\nexport const A = 1\n' }])
    const after = surfaceOf([{ name: 'a.ts', source: '/** new words, longer */\nexport const A = 1\n' }])
    expect(after).toBe(before)
  })
})

describe('checkSurface', () => {
  it('passes when the snapshot is what the source gives, and flags a stale or missing one', () => {
    const source = { 'a.ts': '/** d */\nexport const A = 1\n' }
    const snapshot = surfaceOf([{ name: 'a.ts', source: source['a.ts'] }])
    expect(checkSurface(fixture(source, snapshot)).ok).toBe(true)
    expect(checkSurface(fixture(source, '== a.ts\nexport const A = 2\n')).ok).toBe(false)
    expect(checkSurface(fixture(source)).actual).toBeNull()
  })

  it('ignores files that are not TypeScript sources', () => {
    const root = fixture({ 'a.ts': 'export const A = 1\n', 'README.md': '# notes\n' })
    expect(checkSurface(root).expected).toBe('== a.ts\nexport const A = 1\n')
  })
})

describe('findUnrecordedSurfaceChanges', () => {
  const base = '== a.ts\nexport const A = 1\n== b.ts\nexport const B = 1\n'
  const log = (lines: string[]): string => `# Changelog\n\n## [Unreleased]\n\n${lines.length === 0 ? '' : `### Changed for apps\n\n${lines.join('\n')}\n\n`}## [0.1.0]\n`

  it('names a changed, added or removed file with no record', () => {
    const head = '== a.ts\nexport const A = 2\n== c.ts\nexport const C = 1\n'
    expect(findUnrecordedSurfaceChanges({ baseSnapshot: base, headSnapshot: head, baseChangelog: log([]), headChangelog: log([]) }))
      .toEqual([{ file: 'a.ts', why: 'changed' }, { file: 'b.ts', why: 'removed' }, { file: 'c.ts', why: 'added' }])
  })

  it('accepts a line added under Changed for apps that names the file, and not an old one', () => {
    const head = '== a.ts\nexport const A = 2\n== b.ts\nexport const B = 1\n'
    const recorded = log(['- **`contracts/a.ts`**: A is now 2. Apps must read it as 2. Recheck: all.'])
    expect(findUnrecordedSurfaceChanges({ baseSnapshot: base, headSnapshot: head, baseChangelog: log([]), headChangelog: recorded })).toEqual([])
    expect(findUnrecordedSurfaceChanges({ baseSnapshot: base, headSnapshot: head, baseChangelog: recorded, headChangelog: recorded })).toEqual([{ file: 'a.ts', why: 'changed' }])
  })

  it('reports nothing when the surface is unchanged', () => {
    expect(findUnrecordedSurfaceChanges({ baseSnapshot: base, headSnapshot: base, baseChangelog: log([]), headChangelog: log([]) })).toEqual([])
  })
})
