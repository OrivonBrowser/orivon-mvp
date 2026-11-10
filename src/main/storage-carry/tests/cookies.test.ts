import { describe, expect, it } from 'vitest'
import { cookieBelongsToHost, planCookie } from '../cookies.js'
import type { OldCookie } from '../cookies.js'

const NOW = 1_800_000_000
const base: OldCookie = { name: 'sid', value: 'abc', domain: 'wiki.eth', hostOnly: true, path: '/', secure: true, httpOnly: true, session: false, expirationDate: NOW + 1000, sameSite: 'lax' }

describe('planning one cookie', () => {
  it('keeps every attribute, and a host-only cookie stays host-only by having no domain', () => {
    expect(planCookie(base, NOW)).toEqual({
      kind: 'set',
      cookie: { url: 'https://wiki.eth/', name: 'sid', value: 'abc', path: '/', secure: true, httpOnly: true, expirationDate: NOW + 1000, sameSite: 'lax' }
    })
  })

  it('keeps the domain of a cookie that is not host-only, and builds its address from the domain without the dot', () => {
    const plan = planCookie({ ...base, domain: '.wiki.eth', hostOnly: false, path: '/w' }, NOW)
    expect(plan).toMatchObject({ kind: 'set', cookie: { url: 'https://wiki.eth/w', domain: '.wiki.eth', path: '/w' } })
  })

  it('leaves out the expiry of a session cookie, so it stays one', () => {
    const { expirationDate: _gone, ...noExpiry } = base
    const plan = planCookie({ ...noExpiry, session: true }, NOW)
    expect(plan.kind === 'set' && 'expirationDate' in plan.cookie).toBe(false)
  })

  it('does not carry a cookie that has expired, or one with no domain to set it for', () => {
    expect(planCookie({ ...base, expirationDate: NOW - 1 }, NOW)).toEqual({ kind: 'skip', reason: 'expired' })
    const { domain: _domain, ...bare } = base
    expect(planCookie(bare, NOW)).toEqual({ kind: 'skip', reason: 'no domain' })
  })

  it('carries a none-restriction cookie as it was', () => {
    expect(planCookie({ ...base, sameSite: 'no_restriction' }, NOW)).toMatchObject({ kind: 'set', cookie: { sameSite: 'no_restriction', secure: true } })
  })
})

describe('whether a cookie belongs to the app', () => {
  const host = 'bafy.ipfs.orivon'

  it('is the app\'s when it is host-only on the app\'s own host, whatever the case', () => {
    expect(cookieBelongsToHost({ ...base, domain: host, hostOnly: true }, host)).toBe(true)
    expect(cookieBelongsToHost({ ...base, domain: 'BAFY.ipfs.orivon', hostOnly: true }, host)).toBe(true)
  })

  it('is the app\'s when it is a domain cookie of the host or of a parent of it', () => {
    expect(cookieBelongsToHost({ ...base, domain: `.${host}`, hostOnly: false }, host)).toBe(true)
    expect(cookieBelongsToHost({ ...base, domain: '.ipfs.orivon', hostOnly: false }, host)).toBe(true)
    expect(cookieBelongsToHost({ ...base, domain: 'orivon', hostOnly: false }, host)).toBe(true)
  })

  it('is not the app\'s when it belongs to another site: a tracker, an embed, a sign-in provider', () => {
    for (const domain of ['.google.com', 'accounts.google.com', 'tracker.example', '.evil.orivon']) {
      expect(cookieBelongsToHost({ ...base, domain, hostOnly: domain === 'accounts.google.com' }, host)).toBe(false)
    }
  })

  it('is not the app\'s when it is host-only on a sibling or a child of the host', () => {
    expect(cookieBelongsToHost({ ...base, domain: 'other.ipfs.orivon', hostOnly: true }, host)).toBe(false)
    expect(cookieBelongsToHost({ ...base, domain: `www.${host}`, hostOnly: true }, host)).toBe(false)
  })

  it('is not the app\'s when a domain cookie is for a longer name that merely ends the same way, or has no domain', () => {
    expect(cookieBelongsToHost({ ...base, domain: 'xipfs.orivon', hostOnly: false }, host)).toBe(false)
    const { domain: _domain, ...bare } = base
    expect(cookieBelongsToHost(bare, host)).toBe(false)
  })
})
