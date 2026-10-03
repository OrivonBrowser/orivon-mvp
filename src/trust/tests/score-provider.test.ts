import { describe, expect, it } from 'vitest'
import { SCORE_STANDARD, findEvaluation, parseDescriptor, scoreIdOf } from '../score-provider.js'

const HASH = 'sha256:' + 'ab'.repeat(32)
const CID = 'bafybeieqer67ojhi6q3eiatmrcu3r3mqjehn7hwit2satqjfnljo65fb4q'

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: HASH,
  name: 'Example',
  evaluated: '2026-10-03',
  trustlessity: { level: 3, privacy: false },
  ...overrides
})

const bucketFile = (entries: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  standard: SCORE_STANDARD, subject: 'website', bucket: '4c', entries, ...overrides
})

const lookup = (entries: unknown[], overrides: Record<string, unknown> = {}): ReturnType<typeof findEvaluation> =>
  findEvaluation(bucketFile(entries, overrides), 'website', '4c', HASH)

describe('scoreIdOf', () => {
  it('files a bundle hash under itself and a CID under cid:', () => {
    expect(scoreIdOf({ kind: 'bundle-hash', value: HASH })).toBe(HASH)
    expect(scoreIdOf({ kind: 'cid', value: CID })).toBe(`cid:${CID}`)
  })

  it('refuses a value that is not in the shape the standard names', () => {
    expect(scoreIdOf({ kind: 'bundle-hash', value: 'sha256:' + 'AB'.repeat(32) })).toBeUndefined()
    expect(scoreIdOf({ kind: 'bundle-hash', value: 'ab'.repeat(32) })).toBeUndefined()
    expect(scoreIdOf({ kind: 'cid', value: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' })).toBeUndefined()
  })
})

describe('parseDescriptor', () => {
  it('reads the name, the bucket width and the optional about address', () => {
    expect(parseDescriptor({ standard: SCORE_STANDARD, name: 'P', bucketHexChars: 2 })).toEqual({ name: 'P', bucketHexChars: 2, about: undefined })
    expect(parseDescriptor({ standard: SCORE_STANDARD, name: 'P', bucketHexChars: 4, about: 'https://p.example', extra: 1 })).toEqual({ name: 'P', bucketHexChars: 4, about: 'https://p.example' })
  })

  it('refuses another standard, a missing name and a bucket width outside 1 to 4', () => {
    expect(parseDescriptor({ standard: 'orivon-web3-score/2', name: 'P', bucketHexChars: 2 })).toBeUndefined()
    expect(parseDescriptor({ standard: SCORE_STANDARD, name: '', bucketHexChars: 2 })).toBeUndefined()
    expect(parseDescriptor({ standard: SCORE_STANDARD, name: 'x'.repeat(81), bucketHexChars: 2 })).toBeUndefined()
    for (const bucketHexChars of [0, 5, 2.5, '2']) {
      expect(parseDescriptor({ standard: SCORE_STANDARD, name: 'P', bucketHexChars })).toBeUndefined()
    }
    expect(parseDescriptor([])).toBeUndefined()
  })
})

describe('findEvaluation', () => {
  it('finds the entry for the identifier and reads every field', () => {
    const result = lookup([
      entry({ id: 'sha256:' + 'cd'.repeat(32), name: 'Someone else' }),
      entry({
        version: '1.0',
        summary: 'Open source.',
        operations: [{ name: 'Swap', trustlessity: { level: 5, privacy: true }, note: 'Immutable.' }],
        connections: [{ name: 'RPC', trustlessity: { level: 1 } }],
        evidence: ['https://github.com/example/example']
      })
    ])
    expect(result).toEqual({
      kind: 'found',
      evaluation: {
        id: HASH,
        name: 'Example',
        version: '1.0',
        evaluated: '2026-10-03',
        trustlessity: { level: 3, privacy: false },
        summary: 'Open source.',
        operations: [{ name: 'Swap', trustlessity: { level: 5, privacy: true }, note: 'Immutable.' }],
        connections: [{ name: 'RPC', trustlessity: { level: 1, privacy: false }, note: undefined }],
        evidence: ['https://github.com/example/example']
      }
    })
  })

  it('reports no score when the bucket does not list the identifier', () => {
    expect(lookup([])).toEqual({ kind: 'none' })
    expect(lookup([entry({ id: `cid:${CID}` })])).toEqual({ kind: 'none' })
  })

  it('treats a file for another standard, subject or bucket as a provider that did not answer', () => {
    expect(lookup([entry()], { standard: 'orivon-web3-score/2' }).kind).toBe('malformed')
    expect(lookup([entry()], { subject: 'operation' }).kind).toBe('malformed')
    expect(lookup([entry()], { bucket: '4d' }).kind).toBe('malformed')
    expect(lookup([entry()], { entries: {} }).kind).toBe('malformed')
    expect(findEvaluation(null, 'website', '4c', HASH).kind).toBe('malformed')
  })

  it('drops an evaluation off its scale, or claiming privacy where the scale does not allow it', () => {
    expect(lookup([entry({ trustlessity: { level: 5 } })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ trustlessity: { level: 0 } })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ trustlessity: { level: 3, privacy: true } })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ trustlessity: { level: 4, privacy: true } })]).kind).toBe('found')
    expect(lookup([entry({ operations: [{ name: 'Op', trustlessity: { level: 6 } }] })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ operations: [{ name: 'Op', trustlessity: { level: 3, privacy: true } }] })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ connections: [{ name: 'C', trustlessity: { level: 4 } }] })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ connections: [{ name: 'C', trustlessity: { level: 3, privacy: true } }] })]).kind).toBe('found')
  })

  it('drops an evaluation whose fields break the standard', () => {
    expect(lookup([entry({ name: '' })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ evaluated: '3 October 2026' })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ evaluated: '2026-13-45' })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ summary: 'x'.repeat(601) })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ version: 7 })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ evidence: Array.from({ length: 11 }, () => 'https://e.example') })])).toEqual({ kind: 'none' })
    expect(lookup([entry({ operations: Array.from({ length: 33 }, () => ({ name: 'Op', trustlessity: { level: 1 } })) })])).toEqual({ kind: 'none' })
  })
})
