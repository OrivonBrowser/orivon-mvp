import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkContractsArePure, REQUIRED_CONTRACT_FILES } from './check-contracts-pure.mjs'

/** A root whose src/contracts holds exactly the files given. */
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-contracts-'))
  mkdirSync(join(root, 'src', 'contracts'), { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, 'src', 'contracts', name), body)
  }
  return root
}

/** Every required file present, each holding a valid import-free declaration. */
const complete = (overrides: Record<string, string> = {}): string =>
  fixture({
    ...Object.fromEntries(
      REQUIRED_CONTRACT_FILES.map((name) => [name, 'export type Placeholder = string\n'])
    ),
    ...overrides
  })

describe('checkContractsArePure', () => {
  describe('what it must reject: any module reference', () => {
    it.each([
      ['a value import', "import { app } from 'electron'\nexport type A = string\n"],
      ['a type-only import', "import type { App } from 'electron'\nexport type A = string\n"],
      ['a namespace import', "import * as fs from 'node:fs'\nexport type A = string\n"],
      ['a bare side-effect import', "import 'node:buffer'\nexport type A = string\n"],
      ['a re-export from a sibling', "export type { A } from './errors.js'\n"],
      ['a star re-export', "export * from './errors.js'\n"],
      ['a require call', "const fs = require('node:fs')\nexport type A = string\n"],
      ['a dynamic import', "export const load = () => import('./errors.js')\n"]
    ])('fails on %s', (_label, body) => {
      const result = checkContractsArePure(complete({ 'errors.ts': body }))
      expect(result.ok).toBe(false)
      expect(result.offenders).toEqual(['src/contracts/errors.ts'])
    })

    it('fails on a multi-line re-export', () => {
      const body = "export type {\n  A,\n  B\n} from './errors.js'\n"
      expect(checkContractsArePure(complete({ 'errors.ts': body })).ok).toBe(false)
    })

    it('reports every offender, not just the first', () => {
      const root = complete({
        'errors.ts': "import 'x'\nexport type A = string\n",
        'handles.ts': "import 'y'\nexport type B = string\n"
      })
      expect(checkContractsArePure(root).offenders).toEqual([
        'src/contracts/errors.ts',
        'src/contracts/handles.ts'
      ])
    })
  })

  describe('what it must NOT reject', () => {
    it.each([
      ['a line comment', '// Consumers import this from ./index.js\nexport type A = string\n'],
      ['a block comment', '/**\n * Never import electron here.\n */\nexport type A = string\n'],
      ['an identifier containing the substring import', 'export type Important = string\n'],
      ['an interface with a brace body', 'export interface A { readonly id: string }\n'],
      ['a frozen object literal', 'export const L = { a: 1 } as const\nexport type T = typeof L\n'],
      ['a type alias over typeof', 'export type A = string\nexport type B = A\n']
    ])('allows %s', (_label, body) => {
      expect(checkContractsArePure(complete({ 'errors.ts': body })).ok).toBe(true)
    })

    it('ignores files outside src/contracts', () => {
      const root = complete()
      mkdirSync(join(root, 'src', 'main'), { recursive: true })
      writeFileSync(join(root, 'src', 'main', 'index.ts'), "import { app } from 'electron'\n")
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('ignores a colocated test file', () => {
      const root = complete({
        'scratch.test.ts': "import { it } from 'vitest'\nit.skip('x', () => {})\n"
      })
      expect(checkContractsArePure(root).ok).toBe(true)
    })

    it('ignores a non-TypeScript file', () => {
      const root = complete({ 'notes.md': "Use `import x from 'y'` in your app.\n" })
      expect(checkContractsArePure(root).ok).toBe(true)
    })
  })

  describe('required files', () => {
    it('reports a missing required file', () => {
      const root = complete()
      rmSync(join(root, 'src', 'contracts', 'ipc.ts'))
      const result = checkContractsArePure(root)
      expect(result.ok).toBe(false)
      expect(result.missing).toEqual(['src/contracts/ipc.ts'])
    })

    it('reports the whole set when src/contracts does not exist at all', () => {
      const root = mkdtempSync(join(tmpdir(), 'orivon-contracts-'))
      const result = checkContractsArePure(root)
      expect(result.ok).toBe(false)
      expect(result.missing).toHaveLength(REQUIRED_CONTRACT_FILES.length)
    })

    it('passes on a complete, import-free tree', () => {
      expect(checkContractsArePure(complete())).toEqual({ ok: true, offenders: [], missing: [] })
    })
  })
})
