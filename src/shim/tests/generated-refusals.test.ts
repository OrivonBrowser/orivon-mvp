// Generates and freshness-checks each REFUSAL_TARGETS (A287) generated/*.ts:
// a named export per Node member the target's own module lacks as a NAMED
// export, so a bundler's CommonJS `require()` interop (which hands the
// module's ESM NAMESPACE, never the default, so the default's refusingProxy
// never runs) still names the gap instead of resolving to `undefined`. A
// member real only on the default export (util.isArray, assert.fail, ...)
// is exactly such a gap -- it belongs to the source module as a hand-written
// named export, never a generated stand-in (see ownNamedExports below).
// Compares against node-builtin-exports.ts's checked-in list, never a live
// `require()` (see that file's own header for why). Regenerate deliberately
// with ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NODE_BUILTIN_EXPORTS } from '../node-builtin-exports.js'
import { REFUSAL_TARGETS, type RefusalTarget } from './support/generated-refusal-targets.js'

const SHIM_ROOT = fileURLToPath(new URL('../', import.meta.url))

function toPosix (path: string): string {
  return path.replace(/\\/g, '/')
}

/** A relative import specifier from one src/shim/-relative file to another, always starting `../` (both operands live under src/shim/, never the same directory here). */
function relativeImport (fromFile: string, toFile: string): string {
  const rel = toPosix(relative(posix.dirname(fromFile), toFile))
  return rel.startsWith('.') ? rel : `./${rel}`
}

/**
 * The bound name of one item in a comma-separated export/destructure list: a
 * plain identifier, an `export { a as b }` alias, or an `export const { a:
 * b } = ...` destructure rename -- both renames keep the second (bound)
 * name. The two forms are checked separately, each anchored to the whole
 * piece: `\s*(?:as|:)\s*` alone would let plain identifiers like
 * `createHash` or `getHashes` match themselves as an "as" rename (the
 * letters "as" occur inside "Hash"), since `as` has no required whitespace
 * around it there and `\w+` backtracks to manufacture one.
 */
function boundName (item: string): string | undefined {
  const piece = item.trim()
  if (piece === '') return undefined
  const asForm = /^(\w+)\s+as\s+(\w+)$/.exec(piece)
  if (asForm !== null) return asForm[2]
  const colonForm = /^(\w+)\s*:\s*(\w+)$/.exec(piece)
  if (colonForm !== null) return colonForm[2]
  return piece
}

/**
 * `target`'s own named exports, read from its TypeScript source rather than
 * imported: a top-level `export const/function/class NAME`, `export {
 * NAME[, NAME2 as ALIAS] } [from '...']`, or an `export const { a, b: c } =
 * ...` destructure (an `export type { ... }` is skipped -- erased at
 * compile, so it is never part of a bundled `require()`'s namespace). This
 * deliberately does not import the module and read its live namespace
 * instead: that namespace also carries this same file's `export * from
 * './generated/...'` line, so a member the generator adds a stand-in for
 * this run would look already "covered" by itself on the very next run, and
 * no later hand-written export under the same name would ever displace it
 * in this list again.
 */
function ownNamedExports (target: RefusalTarget): Set<string> {
  const path = `${SHIM_ROOT}${target.sourceModule.replace(/\.js$/, '.ts')}`
  const text = readFileSync(path, 'utf8')
  const names = new Set<string>()
  for (const m of text.matchAll(/^export\s+(?:const|class|(?:async\s+)?function\*?)\s+(\w+)/gm)) {
    const name = m[1]
    if (name !== undefined) names.add(name)
  }
  for (const m of text.matchAll(/^export(\s+type)?\s*\{([^}]*)\}/gm)) {
    if (m[1] !== undefined) continue // `export type { ... }`: erased, not a runtime name
    for (const part of (m[2] ?? '').split(',')) {
      const name = boundName(part)
      if (name !== undefined) names.add(name)
    }
  }
  // `export const { a, b: c } = someObject`: a destructure, not a single-name declaration above.
  for (const m of text.matchAll(/^export\s+const\s*\{([\s\S]*?)\}\s*=/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const name = boundName(part)
      if (name !== undefined) names.add(name)
    }
  }
  return names
}

function expectedSource (target: RefusalTarget): string {
  const own = ownNamedExports(target)
  const nodeExports = NODE_BUILTIN_EXPORTS.modules[target.specifier]
  if (nodeExports === undefined) throw new Error(`node-builtin-exports.generated.json has no '${target.specifier}' entry`)
  const missingFunctions = nodeExports.functions.filter((name) => !own.has(name))
  const missingData = nodeExports.data.filter((name) => !own.has(name))

  const refusingExportImport = relativeImport(target.generatedFile, 'generated-refusal.js')
  const classifyImport = relativeImport(target.generatedFile, target.classifyModule)

  const lines = [
    `// Generated (A287): a named export per Node \`${target.specifier}\` member this shim does`,
    '// not export itself, each throwing the refusal this module\'s own default export already',
    '// throws for the same name -- so a bundler\'s CommonJS require() interop, which hands the',
    '// ESM namespace rather than the default, still names the gap instead of `undefined`. An',
    `// explicit export in ${target.sourceModule.split('/').pop()} shadows one of these, so a member this shim later`,
    '// builds drops its stand-in on the next regeneration. Do not hand-edit -- regenerate with',
    '// ORIVON_WRITE_SHIM_REFUSALS=1 npx vitest run src/shim/tests/generated-refusals.test.ts',
    ''
  ]
  // No import, and no `classify`, when this module already covers every
  // real Node function: an unused stand-in factory would be dead code.
  if (missingFunctions.length > 0) {
    lines.push(
      `import { refusingExport } from '${refusingExportImport}'`,
      `import { ${target.classifyImportName} } from '${classifyImport}'`,
      '',
      `const classify = ${target.classifyExpr}`,
      ''
    )
  }
  for (const name of missingFunctions) lines.push(`export const ${name} = refusingExport('${name}', classify)`)
  lines.push(
    '',
    '/**',
    ` * Node \`${target.specifier}\` members this file has no stand-in for: real Node exposes each`,
    ' * as DATA, not a function, and a throwing stand-in would misreport its own type (A169).',
    ' * Checked by the freshness test above, so a member that changes shape is still seen.',
    ' */',
    `export const DATA_GAPS: readonly string[] = ${JSON.stringify(missingData)}`,
    ''
  )
  return lines.join('\n')
}

// Each case imports a shim module for real; worker_threads' graph carries the whole child
// runtime bundle, which takes seconds to transform on a loaded machine.
const IMPORT_TIMEOUT_MS = 30_000

describe('generated refusal stand-ins (A287)', () => {
  it.each(REFUSAL_TARGETS)('$specifier: generated/*.ts is current', async (target) => {
    const fresh = expectedSource(target)
    const path = `${SHIM_ROOT}${target.generatedFile}`
    if (process.env.ORIVON_WRITE_SHIM_REFUSALS === '1') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, fresh)
    }
    expect(existsSync(path), `${target.generatedFile} is missing -- regenerate with ORIVON_WRITE_SHIM_REFUSALS=1`).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(fresh)
  }, IMPORT_TIMEOUT_MS)

  it.each(REFUSAL_TARGETS)('$specifier: every generated stand-in throws the module\'s own named refusal', async (target) => {
    const generated = await import(/* @vite-ignore */ `../${target.generatedFile.replace(/\.ts$/, '.js')}`) as Record<string, unknown>
    const own = ownNamedExports(target)
    const nodeExports = NODE_BUILTIN_EXPORTS.modules[target.specifier]
    if (nodeExports === undefined) throw new Error(`node-builtin-exports.generated.json has no '${target.specifier}' entry`)
    const missingFunctions = nodeExports.functions.filter((name) => !own.has(name))
    for (const name of missingFunctions) {
      const standIn = generated[name] as (() => void) | undefined
      expect(standIn, `${target.generatedFile} exports '${name}'`).toBeTypeOf('function')
      expect(() => standIn?.()).toThrowError()
      try {
        standIn?.()
        throw new Error('unreachable: standIn above already threw')
      } catch (error) {
        expect((error as { name?: unknown }).name, `${target.specifier}.${name}`).toBe('OrivonShimError')
        expect((error as { api?: unknown }).api, `${target.specifier}.${name}`).toBe(`${target.specifier}.${name}`)
      }
    }
  }, IMPORT_TIMEOUT_MS)
})
