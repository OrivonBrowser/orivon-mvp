import { describe, expect, it } from 'vitest'
import { withoutCookie, withoutSetCookie, withDoNotTrack } from '../privacy-headers.js'

describe('withDoNotTrack', () => {
  it('returns the same object when it is off', () => {
    const headers = { Accept: '*/*' }
    expect(withDoNotTrack(headers, false)).toBe(headers)
  })

  it('adds DNT when it is on, and never Sec-GPC, which the engine sends', () => {
    expect(withDoNotTrack({ Accept: '*/*' }, true)).toEqual({ Accept: '*/*', DNT: '1' })
  })

  it('returns the same object when the header is already set to 1', () => {
    const headers = { DNT: '1' }
    expect(withDoNotTrack(headers, true)).toBe(headers)
  })

  it('replaces a differently cased or different-valued copy rather than adding a second', () => {
    expect(withDoNotTrack({ dnt: '0' }, true)).toEqual({ DNT: '1' })
  })

  it('does not change the headers it was given', () => {
    const headers = { Accept: '*/*' }
    withDoNotTrack(headers, true)
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
