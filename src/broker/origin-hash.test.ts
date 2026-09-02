import { describe, expect, it } from 'vitest'
import { originHash, partitionFor } from './origin-hash.js'

// Frozen vectors -- NEVER edit once merged, same discipline as
// bundle-hash.test.ts's golden vectors. Computed independently, twice: once
// via `printf '%s' '<origin>' | sha256sum`, once via node:crypto directly,
// both cross-checked before being written here. Any change to these values
// means the construction changed, which orphans every app's storage
// directory and session partition that already exists on a real machine
// (ADR-0003's "before the first grant is persisted" one-way door).
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['https://app.example', '2bf585a6f689247104c31bb9cf683e2c8be97bfe0cb266d49c4ef99c81ebbdd6'],
  ['https://app.example:8443', '269af6e421ce5d43bc00ab0d175aadec1ab1ec422c779a4f6ef6f97381b66706'],
  ['http://localhost:3000', 'f1de9e489ba88cb15968b97f40f59e8ef0da5ca03ad1f37fc13a2aa45a2512a9']
]

describe('originHash', () => {
  it.each(VECTORS)('hashes %s to the frozen vector', (origin, expected) => {
    expect(originHash(origin)).toBe(expected)
  })

  it('is always 64 lowercase hex characters', () => {
    expect(originHash('https://anything.example')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two different origins hash differently', () => {
    expect(originHash('https://a.example')).not.toBe(originHash('https://b.example'))
  })

  it('the port is part of the input -- same host, different port, different hash', () => {
    expect(originHash('https://app.example')).not.toBe(originHash('https://app.example:8443'))
  })

  // Pins the precondition rather than pretending it's enforced here:
  // originHash does NOT canonicalize. originFromUrl (policy/origin.ts) is
  // the one definition of canonical, and index.ts's canonical() is the one
  // enforcement point -- callers here are trusted to have already run it,
  // exactly like nodeFs.rootFor's existing contract.
  it('does NOT canonicalize -- differently-cased origins hash differently', () => {
    expect(originHash('https://Example.com')).not.toBe(originHash('https://example.com'))
  })
})

describe('partitionFor', () => {
  it('is exactly persist:app-<originHash> for a known origin', () => {
    expect(partitionFor('https://app.example')).toBe('persist:app-2bf585a6f689247104c31bb9cf683e2c8be97bfe0cb266d49c4ef99c81ebbdd6')
  })

  it('starts with persist: -- an in-memory partition would wipe web storage every restart (ADR-0003)', () => {
    expect(partitionFor('https://app.example')).toMatch(/^persist:/)
  })

  it('never contains the origin string or a scheme separator', () => {
    const partition = partitionFor('https://app.example')
    expect(partition).not.toContain('app.example')
    expect(partition).not.toContain('://')
  })

  it('matches the exact expected shape', () => {
    expect(partitionFor('https://app.example')).toMatch(/^persist:app-[0-9a-f]{64}$/)
  })

  it('derives from the same hash originHash produces -- one derivation, not two', () => {
    const origin = 'https://app.example'
    expect(partitionFor(origin).endsWith(originHash(origin))).toBe(true)
  })

  it('two different origins get two different partitions', () => {
    expect(partitionFor('https://a.example')).not.toBe(partitionFor('https://b.example'))
  })
})
