import { describe, expect, it } from 'vitest'
import { planCookie, sameCookie } from '../cookies.js'
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
    const plan = planCookie({ ...base, session: true, expirationDate: undefined }, NOW)
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

describe('whether a cookie is the one that would be replaced', () => {
  const wanted = (plan: ReturnType<typeof planCookie>) => { if (plan.kind !== 'set') throw new Error('skipped'); return plan.cookie }

  it('is the same name, domain and path, with or without the leading dot', () => {
    expect(sameCookie({ ...base, domain: '.wiki.eth', hostOnly: false }, wanted(planCookie(base, NOW)))).toBe(true)
    expect(sameCookie({ ...base, name: 'other' }, wanted(planCookie(base, NOW)))).toBe(false)
    expect(sameCookie({ ...base, path: '/x' }, wanted(planCookie(base, NOW)))).toBe(false)
    expect(sameCookie({ ...base, domain: 'api.wiki.eth' }, wanted(planCookie(base, NOW)))).toBe(false)
  })
})
