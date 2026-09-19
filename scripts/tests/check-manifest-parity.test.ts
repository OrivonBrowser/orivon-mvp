import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  arrayLiteralItems,
  checkManifestParity,
  CONTRACT_FILE,
  DELIBERATELY_DEFERRED,
  interfaceFields,
  nonReadonlyInterfaceFields,
  PARITY_MAP
} from '../check-manifest-parity.mjs'

/** A scratch root holding the given files, each written at its root-relative path. */
const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-manifest-parity-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

describe('interfaceFields', () => {
  it('reads every readonly member, required and optional alike', () => {
    const source = `
      export interface Widget {
        readonly a: string
        readonly b?: number
      }
    `
    expect(interfaceFields(source, 'Widget')).toEqual(['a', 'b'])
  })

  it('is not fooled by a doc comment that mentions a field-shaped phrase', () => {
    const source = `
      /**
       * readonly trap: not a real field, this is prose describing one.
       */
      export interface Widget {
        readonly a: string
      }
    `
    expect(interfaceFields(source, 'Widget')).toEqual(['a'])
  })

  it('is not fooled by a line comment either', () => {
    const source = `
      export interface Widget {
        // readonly trap: string -- also not real
        readonly a: string
      }
    `
    expect(interfaceFields(source, 'Widget')).toEqual(['a'])
  })

  it('handles a field typed as a readonly array, without over-matching into the type', () => {
    const source = `
      export interface Widget {
        readonly assets?: readonly string[]
        readonly next: string
      }
    `
    expect(interfaceFields(source, 'Widget')).toEqual(['assets', 'next'])
  })

  it('returns null when the interface is not present at all -- a config bug, not zero fields', () => {
    const source = 'export interface SomethingElse { readonly x: string }'
    expect(interfaceFields(source, 'Widget')).toBeNull()
  })

  // A176 point 1: a field nested inside another field's own inline object
  // type used to be read as a sibling of the field that contains it.
  it('does not flatten a field nested inside another field\'s inline object type', () => {
    const source = 'export interface Foo { readonly bar?: { readonly nested: string }\n' +
      ' readonly baz: number }'
    expect(interfaceFields(source, 'Foo')).toEqual(['bar', 'baz'])
  })

  it('masks a nested object field even when it repeats a real top-level name', () => {
    // The dangerous case named in A176: a nested field whose name collides
    // with a real top-level key would mask that the nesting was never
    // checked at all -- deduping 'baz' against itself proves nothing; this
    // proves the nested 'baz' was never extracted in the first place.
    const source = 'export interface Foo { readonly bar?: { readonly baz: string }\n' +
      ' readonly baz: number }'
    expect(interfaceFields(source, 'Foo')).toEqual(['bar', 'baz'])
  })

  // A176 point 2: a field missing the `readonly` keyword used to vanish
  // from the list entirely rather than being reported as a convention gap.
  it('still reports a field that is missing the readonly keyword, rather than dropping it', () => {
    const source = 'export interface Widget { readonly a: string\n b: number }'
    expect(interfaceFields(source, 'Widget')).toEqual(['a', 'b'])
  })

  it('stops at the interface\'s own closing brace, not a later one', () => {
    const source = `
      export interface Widget {
        readonly a: string
      }
      export interface Other {
        readonly z: string
      }
    `
    expect(interfaceFields(source, 'Widget')).toEqual(['a'])
    expect(interfaceFields(source, 'Other')).toEqual(['z'])
  })
})

describe('arrayLiteralItems', () => {
  it('reads single- and double-quoted string literals alike', () => {
    const source = "const WIDGET_KEYS = ['a', \"b\", 'c']"
    expect(arrayLiteralItems(source, 'WIDGET_KEYS')).toEqual(['a', 'b', 'c'])
  })

  it('is not fooled by a trailing comment naming a fake item', () => {
    const source = "const WIDGET_KEYS = ['a'] // pretend this also listed 'z'"
    expect(arrayLiteralItems(source, 'WIDGET_KEYS')).toEqual(['a'])
  })

  it('returns null when the array cannot be found', () => {
    expect(arrayLiteralItems("const OTHER_KEYS = ['a']", 'WIDGET_KEYS')).toBeNull()
  })
})

describe('nonReadonlyInterfaceFields', () => {
  it('is empty when every top-level member says readonly', () => {
    const source = 'export interface Widget { readonly a: string\n readonly b?: number }'
    expect(nonReadonlyInterfaceFields(source, 'Widget')).toEqual([])
  })

  it('names a top-level member missing readonly, and only that one', () => {
    const source = 'export interface Widget { readonly a: string\n b: number }'
    expect(nonReadonlyInterfaceFields(source, 'Widget')).toEqual(['b'])
  })

  it('does not reach into a nested inline object type\'s own members', () => {
    // A field inside a nested object missing readonly is that field's own
    // interface's problem (if it is one), not Widget's -- this function
    // must stay scoped to the same top level interfaceFields is.
    const source = 'export interface Widget { readonly a?: { nested: string }\n readonly b: number }'
    expect(nonReadonlyInterfaceFields(source, 'Widget')).toEqual([])
  })

  it('returns null when the interface is not present at all', () => {
    expect(nonReadonlyInterfaceFields('export interface Other { readonly x: string }', 'Widget')).toBeNull()
  })
})

describe('checkManifestParity', () => {
  const parityMap = [
    { interfaceName: 'Widget', loaderFile: 'src/loader/widget.ts', arrayName: 'WIDGET_KEYS' }
  ]

  it('passes when the loader array lists every contract field', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string\n readonly b?: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a', 'b']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(true)
    expect(result.gaps).toEqual([])
  })

  // This is A164 and the consentGranularity gap, reproduced synthetically: a
  // field the contract declares that the loader's own allowlist never
  // learned about.
  it('fails, naming the exact field, when the loader array is missing one', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string\n readonly b?: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.gaps).toEqual([
      { interfaceName: 'Widget', field: 'b', loaderFile: 'src/loader/widget.ts', arrayName: 'WIDGET_KEYS' }
    ])
  })

  it('a field named in DELIBERATELY_DEFERRED, with a reason, does not fail', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string\n readonly b?: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a']"
    })
    const deferred = [{ interfaceName: 'Widget', field: 'b', reason: 'not implemented yet, test fixture' }]
    const result = checkManifestParity(root, { parityMap, deferred })
    expect(result.ok).toBe(true)
    expect(result.gaps).toEqual([])
  })

  it('fails closed, listing what it could not find, when the interface itself is missing', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface SomethingElse { readonly z: string }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toEqual(['interface Widget in src/contracts/manifest.ts'])
  })

  it('fails closed, listing what it could not find, when the loader array itself is missing', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string }',
      'src/loader/widget.ts': "const SOME_OTHER_ARRAY = ['a']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toEqual(['WIDGET_KEYS in src/loader/widget.ts'])
  })

  // ADR-0019: a brand-new interface's loader array does not exist at all
  // yet, on purpose, in the contracts-only PR that declares it -- this must
  // not read as the same "unreadable" failure a stale regex would produce.
  it('does not fail on a missing loader array when every field of the interface is deliberately deferred', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a?: string }',
      'src/loader/widget.ts': "const SOME_OTHER_ARRAY = ['z']"
    })
    const deferred = [{ interfaceName: 'Widget', field: 'a', reason: 'not implemented yet, test fixture' }]
    const result = checkManifestParity(root, { parityMap, deferred })
    expect(result.ok).toBe(true)
    expect(result.unreadable).toEqual([])
    expect(result.gaps).toEqual([])
  })

  it('still fails closed on a missing loader array when only SOME fields are deferred', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a?: string\n readonly b?: number }',
      'src/loader/widget.ts': "const SOME_OTHER_ARRAY = ['z']"
    })
    const deferred = [{ interfaceName: 'Widget', field: 'a', reason: 'not implemented yet, test fixture' }]
    const result = checkManifestParity(root, { parityMap, deferred })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toEqual(['WIDGET_KEYS in src/loader/widget.ts'])
  })

  it('still fails closed on a missing loader array when no field is deferred at all', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a?: string }',
      'src/loader/widget.ts': "const SOME_OTHER_ARRAY = ['z']"
    })
    const result = checkManifestParity(root, { parityMap, deferred: [] })
    expect(result.ok).toBe(false)
    expect(result.unreadable).toEqual(['WIDGET_KEYS in src/loader/widget.ts'])
  })

  // A176 point 2, at the checkManifestParity level: the field is no longer
  // dropped, so it now also surfaces as an ordinary gap when the loader
  // array does not list it either.
  it('reports a field missing readonly both as a gap and in missingReadonly, when the loader does not list it', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string\n b: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.gaps).toEqual([
      { interfaceName: 'Widget', field: 'b', loaderFile: 'src/loader/widget.ts', arrayName: 'WIDGET_KEYS' }
    ])
    expect(result.missingReadonly).toEqual([{ interfaceName: 'Widget', field: 'b' }])
  })

  // The case the fix is actually for: a dropped keyword must fail loudly
  // even when the field's name already happens to be in the loader's
  // allowlist -- the missing keyword is the defect, not the gap.
  it('still fails on missingReadonly alone, even when the loader array already lists the field', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a: string\n b: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a', 'b']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.gaps).toEqual([])
    expect(result.missingReadonly).toEqual([{ interfaceName: 'Widget', field: 'b' }])
  })

  it('reports a gap for every unmatched field, not just the first', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly a?: string\n readonly b?: number\n readonly c?: boolean }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['a']"
    })
    const result = checkManifestParity(root, { parityMap })
    expect(result.ok).toBe(false)
    expect(result.gaps.map((g) => g.field)).toEqual(['b', 'c'])
  })

  // A176 point 1, at the checkManifestParity level: before the fix, 'nested'
  // would have been extracted as a phantom top-level field and reported as
  // a gap (nothing named 'nested' belongs in WIDGET_KEYS), even though
  // 'bar' and 'baz' -- the interface's real fields -- are both covered.
  it('does not report a phantom gap for a nested inline-object field', () => {
    const root = fixture({
      'src/contracts/manifest.ts': 'export interface Widget { readonly bar?: { readonly nested: string }\n' +
        ' readonly baz: number }',
      'src/loader/widget.ts': "const WIDGET_KEYS = ['bar', 'baz']"
    })
    const result = checkManifestParity(root, { parityMap: [
      { interfaceName: 'Widget', loaderFile: 'src/loader/widget.ts', arrayName: 'WIDGET_KEYS' }
    ] })
    expect(result.ok).toBe(true)
    expect(result.gaps).toEqual([])
  })

  it('passes the real tree as it stands on main -- every current PARITY_MAP row, with the real DELIBERATELY_DEFERRED list', () => {
    const result = checkManifestParity(process.cwd())
    expect(result.unreadable).toEqual([])
    expect(result.gaps).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('reproduces the actual A164 regression against the real files: pulling "https" out of NET_KEYS fails the check', () => {
    // A copy of the real files, not the files themselves -- this proves the
    // check's OWN logic reacts to exactly the historical bug, without
    // mutating the tracked source (that demonstration is run separately,
    // directly against the tracked files, and pasted into the PR body).
    const contractSource = readRealFile(CONTRACT_FILE)
    const loaderSource = readRealFile('src/loader/manifest-capabilities.ts')
    const withoutHttps = loaderSource.replace(
      "const NET_KEYS = ['tcp', 'udp', 'https', 'concurrentSockets']",
      "const NET_KEYS = ['tcp', 'udp', 'concurrentSockets']"
    )
    expect(withoutHttps).not.toEqual(loaderSource) // the replace actually matched something

    const netRow = PARITY_MAP.find((row) => row.interfaceName === 'NetCapability')
    if (netRow === undefined) throw new Error('PARITY_MAP has no NetCapability row')

    const root = fixture({
      [CONTRACT_FILE]: contractSource,
      [netRow.loaderFile]: withoutHttps
    })
    const result = checkManifestParity(root, { parityMap: [netRow], deferred: DELIBERATELY_DEFERRED })
    expect(result.ok).toBe(false)
    expect(result.gaps).toEqual([
      { interfaceName: 'NetCapability', field: 'https', loaderFile: netRow.loaderFile, arrayName: 'NET_KEYS' }
    ])
  })
})

function readRealFile (path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}
