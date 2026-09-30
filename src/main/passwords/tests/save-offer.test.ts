import { describe, expect, it } from 'vitest'
import { classify, judge, KEEP_MS, QUIET_MS, SUCCESS_WINDOW_MS } from '../save-offer.js'
import type { Navigation, Observed, PendingCredential } from '../save-offer.js'
import { memoryVault } from '../vault.js'

const ORIGIN = 'https://site.example'
const pending: PendingCredential = { origin: ORIGIN, username: 'ada', password: 'pw-1', at: 1000 }
const nav = (over: Partial<Navigation> = {}): Navigation => ({ at: 1500, inPage: false, status: 200, origin: ORIGIN, ...over })
const seen = (over: Partial<Observed> = {}): Observed => ({ navigations: [], fields: null, ...over })
const gone = (at = 2000): Observed['fields'] => ({ hasPassword: false, at })
const still = (at = 2000): Observed['fields'] => ({ hasPassword: true, at })

describe('judge: a full navigation after the submit', () => {
  it('offers when the next page has no password field', () => {
    expect(judge(pending, seen({ navigations: [nav()], fields: gone() }), 2500)).toBe('offer')
  })

  it('drops when the same origin shows a password field again: the sign-in failed', () => {
    expect(judge(pending, seen({ navigations: [nav()], fields: still() }), 2500)).toBe('drop')
  })

  it('waits for the new page to report its fields, then drops when none comes in time', () => {
    expect(judge(pending, seen({ navigations: [nav()] }), 2500)).toBe('wait')
    expect(judge(pending, seen({ navigations: [nav()] }), pending.at + SUCCESS_WINDOW_MS + 1)).toBe('drop')
  })

  it('ignores a field report made before the page that followed the submit', () => {
    expect(judge(pending, seen({ navigations: [nav({ at: 1800 })], fields: still(1600) }), 2500)).toBe('wait')
  })

  it('drops on an error status', () => {
    expect(judge(pending, seen({ navigations: [nav({ status: 401 })], fields: gone() }), 2500)).toBe('drop')
    expect(judge(pending, seen({ navigations: [nav({ status: 500 })], fields: gone() }), 2500)).toBe('drop')
  })

  it('drops when the tab went to another origin', () => {
    expect(judge(pending, seen({ navigations: [nav({ origin: 'https://other.example' })], fields: gone() }), 2500)).toBe('drop')
    expect(judge(pending, seen({ navigations: [nav({ origin: null })], fields: gone() }), 2500)).toBe('drop')
  })

  it('does not count a navigation from before the submit', () => {
    expect(judge(pending, seen({ navigations: [nav({ at: 500, status: 404 })] }), 1600)).toBe('wait')
  })

  it('judges by the last full navigation when there are several', () => {
    const navigations = [nav({ at: 1500 }), nav({ at: 1900 })]
    expect(judge(pending, seen({ navigations, fields: still(1700) }), 2500)).toBe('wait')
    expect(judge(pending, seen({ navigations, fields: gone(2000) }), 2500)).toBe('offer')
  })
})

describe('judge: no full navigation', () => {
  it('offers after a same-document navigation once the password field is gone', () => {
    expect(judge(pending, seen({ navigations: [nav({ inPage: true, status: -1 })], fields: gone() }), 2500)).toBe('offer')
  })

  it('offers a page that only lost its field after it has been quiet for a moment', () => {
    expect(judge(pending, seen({ fields: gone(1200) }), pending.at + QUIET_MS - 1)).toBe('wait')
    expect(judge(pending, seen({ fields: gone(1200) }), pending.at + QUIET_MS)).toBe('offer')
  })

  it('waits while the field is still there, and drops when it never goes', () => {
    expect(judge(pending, seen({ fields: still() }), 3000)).toBe('wait')
    expect(judge(pending, seen({ navigations: [nav({ inPage: true, status: -1 })], fields: still() }), 3000)).toBe('wait')
    expect(judge(pending, seen({ fields: still() }), pending.at + SUCCESS_WINDOW_MS + 1)).toBe('drop')
  })

  it('a same-document navigation to another origin drops it', () => {
    expect(judge(pending, seen({ navigations: [nav({ inPage: true, status: -1, origin: 'https://other.example' })] }), 2500)).toBe('drop')
  })

  it('a same-document error status does not count as a failed page load', () => {
    expect(judge(pending, seen({ navigations: [nav({ inPage: true, status: 404 })], fields: gone() }), 2500)).toBe('offer')
  })
})

describe('judge: age', () => {
  it('drops once the credential is older than it is kept', () => {
    expect(judge(pending, seen({ navigations: [nav()], fields: gone() }), pending.at + KEEP_MS + 1)).toBe('drop')
  })
})

describe('classify', () => {
  it('is a save when the origin has no login with that username', async () => {
    const vault = memoryVault()
    expect(await classify(vault, pending)).toEqual({ kind: 'save' })
    await vault.save({ origin: ORIGIN, username: 'grace', password: 'x' })
    await vault.save({ origin: 'https://other.example', username: 'ada', password: 'x' })
    expect(await classify(vault, pending)).toEqual({ kind: 'save' })
  })

  it('is an update when the login exists with another password', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'old' })
    expect(await classify(vault, pending)).toEqual({ kind: 'update', login })
  })

  it('is nothing when the same password is already kept', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw-1' })
    expect(await classify(vault, pending)).toEqual({ kind: 'none', login })
  })

  it('treats an empty username as a username of its own', async () => {
    const vault = memoryVault()
    await vault.save({ origin: ORIGIN, username: '', password: 'old' })
    const result = await classify(vault, { ...pending, username: '' })
    expect(result.kind).toBe('update')
  })
})
