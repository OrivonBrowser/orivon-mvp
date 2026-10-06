import { describe, expect, it } from 'vitest'
import { MAX_QUIET_OFFERS, isQuiet, parseUpdateOffer, withQuiet } from '../update-offer.js'

const A = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const B = 'bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4'

/** Distinct well-formed CIDs for a test that needs many. */
function cidNumber (i: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  return `b${'a'.repeat(20)}${letters[i % 26] ?? 'a'}${letters[Math.floor(i / 26)] ?? 'a'}`
}

describe('the update offers a person asked not to be asked about again', () => {
  it('is empty for anything that is not a record', () => {
    for (const raw of [undefined, null, 3, 'x', [], {}, { quiet: 'x' }]) expect(parseUpdateOffer(raw)).toEqual({ quiet: [] })
  })

  it('keeps well-formed entries and drops the rest', () => {
    const raw = { quiet: [{ cid: A, verified: true }, { cid: 'not a cid', verified: true }, { cid: B }, { cid: B, verified: false }, 7] }
    expect(parseUpdateOffer(raw)).toEqual({ quiet: [{ cid: A, verified: true }, { cid: B, verified: false }] })
  })

  it('treats a verified offer and an unverified one for the same CID as different questions', () => {
    const record = withQuiet({ quiet: [] }, { cid: A, verified: false })
    expect(isQuiet(record, A, false)).toBe(true)
    expect(isQuiet(record, A, true)).toBe(false)
    expect(isQuiet(record, B, false)).toBe(false)
  })

  it('does not record the same offer twice, and keeps the newest MAX_QUIET_OFFERS', () => {
    const once = withQuiet({ quiet: [] }, { cid: A, verified: true })
    expect(withQuiet(once, { cid: A, verified: true })).toEqual(once)
    let record = once
    for (let i = 0; i < MAX_QUIET_OFFERS + 4; i += 1) record = withQuiet(record, { cid: cidNumber(i), verified: true })
    expect(record.quiet).toHaveLength(MAX_QUIET_OFFERS)
    expect(isQuiet(record, A, true)).toBe(false)
  })
})
