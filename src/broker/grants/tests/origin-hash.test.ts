import { describe, expect, it } from 'vitest'
import { HASHED_PARTITION_KINDS, PARTITION_HASH_LENGTH, hashedPartitionName, originHash, partitionFor, partitionHash, partitionPrefix } from '../origin-hash.js'

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
  it('is exactly persist:app-<first 32 digits of originHash> for a known origin', () => {
    expect(partitionFor('https://app.example')).toBe('persist:app-2bf585a6f689247104c31bb9cf683e2c')
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
    expect(partitionFor('https://app.example')).toMatch(/^persist:app-[0-9a-f]{32}$/)
  })

  it('derives from the same hash originHash produces -- one derivation, not two', () => {
    const origin = 'https://app.example'
    expect(originHash(origin).startsWith(partitionFor(origin).slice('persist:app-'.length))).toBe(true)
  })

  it('two different origins get two different partitions', () => {
    expect(partitionFor('https://a.example')).not.toBe(partitionFor('https://b.example'))
  })
})

describe('the names of the sessions made from an origin', () => {
  const origin = 'https://app.example'

  it('keep the first PARTITION_HASH_LENGTH digits of originHash', () => {
    expect(PARTITION_HASH_LENGTH).toBe(32)
    expect(partitionHash(origin)).toBe(originHash(origin).slice(0, PARTITION_HASH_LENGTH))
  })

  it.each(HASHED_PARTITION_KINDS)('are persistent, carry their kind and end in the 32 digits: %s', (kind) => {
    expect(hashedPartitionName(kind, origin)).toBe(`persist:${kind}-${partitionHash(origin)}`)
    expect(hashedPartitionName(kind, origin).startsWith(partitionPrefix(kind))).toBe(true)
  })

  it('differ by kind for one origin, and by origin for one kind', () => {
    const names = new Set(HASHED_PARTITION_KINDS.map((kind) => hashedPartitionName(kind, origin)))
    expect(names.size).toBe(HASHED_PARTITION_KINDS.length)
    expect(hashedPartitionName('app', 'https://a.example')).not.toBe(hashedPartitionName('app', 'https://b.example'))
  })

  it('leave a profile folder of 80 characters room for a service worker\'s cache index on Windows', () => {
    const profileFolder = 80
    const below = '\\Partitions\\app-'.length + PARTITION_HASH_LENGTH + '\\Service Worker\\CacheStorage\\'.length + 40 + '\\'.length + 36 + '\\index-dir\\the-real-index'.length
    expect(profileFolder + below).toBeLessThanOrEqual(259)
  })
})
