import { describe, expect, it } from 'vitest'
import { withoutCookie, withoutSetCookie, withPrivacySignals } from '../privacy-headers.js'

describe('withPrivacySignals', () => {
  it('returns the same object when both signals are off', () => {
    const headers = { Accept: '*/*' }
    expect(withPrivacySignals(headers, { gpc: false, dnt: false })).toBe(headers)
  })

  it('adds only the signal that is on', () => {
    expect(withPrivacySignals({ Accept: '*/*' }, { gpc: true, dnt: false })).toEqual({ Accept: '*/*', 'Sec-GPC': '1' })
    expect(withPrivacySignals({ Accept: '*/*' }, { gpc: false, dnt: true })).toEqual({ Accept: '*/*', DNT: '1' })
    expect(withPrivacySignals({}, { gpc: true, dnt: true })).toEqual({ 'Sec-GPC': '1', DNT: '1' })
  })

  it('returns the same object when the header is already set to 1', () => {
    const headers = { 'Sec-GPC': '1', DNT: '1' }
    expect(withPrivacySignals(headers, { gpc: true, dnt: true })).toBe(headers)
  })

  it('replaces a differently cased or different-valued copy rather than adding a second', () => {
    expect(withPrivacySignals({ 'sec-gpc': '0' }, { gpc: true, dnt: false })).toEqual({ 'Sec-GPC': '1' })
    expect(withPrivacySignals({ dnt: '0' }, { gpc: false, dnt: true })).toEqual({ DNT: '1' })
  })

  it('does not change the headers it was given', () => {
    const headers = { Accept: '*/*' }
    withPrivacySignals(headers, { gpc: true, dnt: true })
    expect(headers).toEqual({ Accept: '*/*' })
  })
})

describe('withoutSetCookie', () => {
  it('removes every spelling of the header, so cookies split across two spellings do not survive', () => {
    expect(withoutSetCookie({ 'Set-Cookie': ['a=1'], 'set-cookie': ['b=2'], 'Content-Type': ['text/html'] })).toEqual({ 'Content-Type': ['text/html'] })
  })
})

describe('withoutCookie', () => {
  it('removes every spelling of the Cookie header', () => {
    expect(withoutCookie({ Cookie: 'a=1', cookie: 'b=2', Accept: '*/*' })).toEqual({ Accept: '*/*' })
  })

  it('removes the Cookie header whatever its case', () => {
    expect(withoutCookie({ Accept: '*/*', Cookie: 'a=1' })).toEqual({ Accept: '*/*' })
    expect(withoutCookie({ cookie: 'a=1' })).toEqual({})
  })

  it('returns the same object when there is no cookie', () => {
    const headers = { Accept: '*/*' }
    expect(withoutCookie(headers)).toBe(headers)
  })
})

describe('withoutSetCookie', () => {
  it('removes every Set-Cookie line', () => {
    expect(withoutSetCookie({ 'Set-Cookie': ['a=1', 'b=2'], 'Content-Type': ['text/html'] })).toEqual({ 'Content-Type': ['text/html'] })
    expect(withoutSetCookie({ 'set-cookie': ['a=1'] })).toEqual({})
  })

  it('returns the same object when there is none', () => {
    const headers = { 'Content-Type': ['text/html'] }
    expect(withoutSetCookie(headers)).toBe(headers)
  })
})
