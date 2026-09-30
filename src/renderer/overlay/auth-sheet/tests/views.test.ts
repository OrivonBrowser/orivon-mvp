import { describe, expect, it } from 'vitest'
import { isChooserView } from '../../chooser/page.js'
import { isCertificatePage, validityNote } from '../../certificate/page.js'
import { isAuthView } from '../page.js'

const AUTH = { id: 'c1', title: 'Sign in', origin: 'http://a.test', line: 'l', realm: null, mismatch: null, insecure: null, retry: false, username: '', saved: null, canRemember: false }

describe('what the overlay pages accept from main', () => {
  it('takes a whole sign-in view and nothing less', () => {
    expect(isAuthView(AUTH)).toBe(true)
    expect(isAuthView({ ...AUTH, realm: 'R', saved: 'alice' })).toBe(true)
    for (const bad of [undefined, null, 'x', {}, { ...AUTH, id: 1 }, { ...AUTH, retry: 'no' }, { ...AUTH, realm: undefined }]) expect(isAuthView(bad)).toBe(false)
  })

  it('takes a chooser question with rows that have an id and a title', () => {
    const view = { id: 'q', title: 'T', origin: null, line: null, confirm: 'Go', empty: 'None', items: [{ id: 'a', title: 'A' }] }
    expect(isChooserView(view)).toBe(true)
    expect(isChooserView({ ...view, items: [] })).toBe(true)
    for (const bad of [undefined, {}, { ...view, items: [{ id: 'a' }] }, { ...view, items: 'a' }, { ...view, confirm: 1 }]) expect(isChooserView(bad)).toBe(false)
  })

  it('takes a host with a chain or with none', () => {
    expect(isCertificatePage({ host: 'a.test', chain: null })).toBe(true)
    expect(isCertificatePage({ host: 'a.test', chain: [{}] })).toBe(true)
    for (const bad of [undefined, { host: 1, chain: null }, { host: 'a', chain: 'x' }, { host: 'a' }]) expect(isCertificatePage(bad)).toBe(false)
  })

  it('marks a certificate that is expired or not yet valid, and only at the end that says so', () => {
    const certificate = { validFrom: 100, validUntil: 200 }
    expect(validityNote(certificate, 'until', 150)).toBeNull()
    expect(validityNote(certificate, 'until', 250)).toBe('expired')
    expect(validityNote(certificate, 'from', 50)).toBe('not yet valid')
    expect(validityNote(certificate, 'from', 150)).toBeNull()
  })
})
