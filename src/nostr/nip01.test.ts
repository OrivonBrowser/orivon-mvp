import { describe, expect, it } from 'vitest'
import { computeEventId, validateUnsignedEvent } from './nip01.js'

// A key reused across every vector below purely so the vectors read
// consistently -- it carries no other significance and is not a real key.
const PUBKEY = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e'

// ===========================================================================
// FROZEN GOLDEN VECTORS -- computed and cross-checked by TWO independent
// implementations, neither of them this file or nip01.ts:
//
//   1. Python: hashlib.sha256(json.dumps(arr, separators=(',',':'),
//      ensure_ascii=False).encode('utf8')).hexdigest()
//   2. Node:   crypto.createHash('sha256').update(JSON.stringify(arr),
//      'utf8').digest('hex')
//
// Both produced byte-identical serialized strings and hex digests for all
// three vectors below. json.dumps(ensure_ascii=False) and JSON.stringify
// agree because both escape only " \ and the control characters NIP-01 names
// (\n \r \t \b \f, plus \u00XX for any other control character below 0x20)
// and neither inserts whitespace without an explicit indent argument -- so
// this is a genuine cross-language check, not one implementation validating
// itself. If a change here makes a vector below fail, THE CHANGE IS WRONG:
// re-derive by hand (or with a fresh script that never imports nip01.ts)
// before touching these bytes, the same discipline bundle-hash.ts's and
// derive.ts's frozen tables use.
// ===========================================================================

describe('computeEventId -- frozen golden vectors', () => {
  it('vector A: kind 1, no tags, plain content', async () => {
    // serialized: [0,"7e7e...df4e",1700000000,1,[],"Hello, Nostr!"]
    const id = await computeEventId({
      pubkey: PUBKEY,
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Hello, Nostr!'
    })
    expect(id).toBe('5fe8a6aae00f529679227f078a9bdd91a546565c6484d782979dc9e97791a5af')
  })

  it('vector B: tags present, content needs escaping (newline, quote, backslash)', async () => {
    const id = await computeEventId({
      pubkey: PUBKEY,
      created_at: 1700000000,
      kind: 1,
      tags: [['e', 'abc'], ['p', PUBKEY]],
      content: 'line one\nline two "quoted" and \\backslash\\'
    })
    expect(id).toBe('867aee3c6abb057bd38f6ad797e77d38ead92bb70322d1881f0c6e4209a21e79')
  })

  it('vector C: kind 0 (metadata), content is itself a JSON string', async () => {
    const id = await computeEventId({
      pubkey: PUBKEY,
      created_at: 1700000000,
      kind: 0,
      tags: [],
      content: '{"name":"orivon"}'
    })
    expect(id).toBe('204f9ddb67373d5965e6686e66d33c32f380a4805a278751523928c219e2bdd8')
  })

  it('is injective in the field boundary the same way bundle-hash.ts tests for it: changing which array holds a tag changes the id', async () => {
    const withOneTwoTags = await computeEventId({
      pubkey: PUBKEY,
      created_at: 1700000000,
      kind: 1,
      tags: [['a', '1'], ['b', '2']],
      content: ''
    })
    const withSwappedTagContents = await computeEventId({
      pubkey: PUBKEY,
      created_at: 1700000000,
      kind: 1,
      tags: [['a', '2'], ['b', '1']],
      content: ''
    })
    expect(withOneTwoTags).not.toBe(withSwappedTagContents)
  })

  it('rejects a pubkey that is not lowercase (uppercase hex would silently serialize to a different, wrong id)', async () => {
    await expect(computeEventId({
      pubkey: PUBKEY.toUpperCase(),
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: ''
    })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects a pubkey of the wrong length', async () => {
    await expect(computeEventId({
      pubkey: PUBKEY.slice(0, 62),
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: ''
    })).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('validateUnsignedEvent', () => {
  const valid = { created_at: 1700000000, kind: 1, tags: [], content: 'hi' }

  it('accepts a well-formed event', () => {
    expect(() => validateUnsignedEvent(valid)).not.toThrow()
  })

  it('rejects a non-object', () => {
    expect(() => validateUnsignedEvent(null)).toThrow(/object/i)
    expect(() => validateUnsignedEvent('not an event')).toThrow(/object/i)
  })

  it('rejects a non-integer created_at', () => {
    expect(() => validateUnsignedEvent({ ...valid, created_at: 1700000000.5 })).toThrow(/created_at/)
  })

  it('rejects a negative created_at', () => {
    expect(() => validateUnsignedEvent({ ...valid, created_at: -1 })).toThrow(/created_at/)
  })

  it('rejects a non-integer kind', () => {
    expect(() => validateUnsignedEvent({ ...valid, kind: 1.5 })).toThrow(/kind/)
  })

  it('rejects a kind outside 0-65535', () => {
    expect(() => validateUnsignedEvent({ ...valid, kind: -1 })).toThrow(/kind/)
    expect(() => validateUnsignedEvent({ ...valid, kind: 65536 })).toThrow(/kind/)
  })

  it('rejects tags that are not an array', () => {
    expect(() => validateUnsignedEvent({ ...valid, tags: 'nope' })).toThrow(/tags/)
  })

  it('rejects a tag that is not an array of strings', () => {
    expect(() => validateUnsignedEvent({ ...valid, tags: [['ok', 1]] })).toThrow(/tags/)
    expect(() => validateUnsignedEvent({ ...valid, tags: ['not-an-array'] })).toThrow(/tags/)
  })

  it('rejects non-string content', () => {
    expect(() => validateUnsignedEvent({ ...valid, content: 42 })).toThrow(/content/)
  })

  it('accepts kind 0 and kind 65535, the range boundaries', () => {
    expect(() => validateUnsignedEvent({ ...valid, kind: 0 })).not.toThrow()
    expect(() => validateUnsignedEvent({ ...valid, kind: 65535 })).not.toThrow()
  })
})
