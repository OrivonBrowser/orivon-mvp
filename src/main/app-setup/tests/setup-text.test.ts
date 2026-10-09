import { describe, expect, it } from 'vitest'
import { coverFor, displayName, MAX_LISTED_FILES, sheetView } from '../setup-text.js'

describe('displayName', () => {
  it('shortens a long name and drops control characters, since the name is the app\'s own text', () => {
    expect(displayName('Wallet\u0007\n App')).toBe('Wallet App')
    expect(displayName('x'.repeat(200))).toHaveLength(80)
    expect(displayName('x'.repeat(200)).endsWith('...')).toBe(true)
    expect(displayName('   ')).toBe('this app')
  })
})

describe('coverFor', () => {
  it('words each stage with the app\'s name', () => {
    expect(coverFor({ kind: 'asking', name: 'Ledger' })).toMatchObject({ title: 'Opening Ledger', busy: true })
    expect(coverFor({ kind: 'verifying', name: 'Ledger' })).toMatchObject({ title: 'Setting up Ledger', busy: true })
    expect(coverFor({ kind: 'verifying', name: 'Ledger' }).detail).toMatch(/checks/i)
  })

  it('says nothing is moving once a sheet explains what happened', () => {
    expect(coverFor({ kind: 'blocked', name: 'Ledger' })).toMatchObject({ title: 'Ledger was not opened', busy: false })
    expect(coverFor({ kind: 'download-failed', name: 'Ledger' })).toMatchObject({ title: 'Ledger was not opened', busy: false })
  })
})

describe('sheetView', () => {
  const blocked = { kind: 'blocked' as const, name: 'Ledger', differing: ['/app.js', '/index.html'], differingCount: 2, rootMatches: true }

  it('is a security warning for files that differ, naming them, with no way to try again', () => {
    const view = sheetView(blocked, 'ipfs://abc/', 'token-1')
    expect(view).toMatchObject({ token: 'token-1', kind: 'blocked', canRetry: false, files: ['/app.js', '/index.html'], address: 'ipfs://abc/' })
    expect(view.title).toMatch(/security warning/i)
    expect(view.body).toMatch(/Ledger/)
    expect(view.body).toMatch(/Nothing was granted/)
    expect(view.body).toMatch(/removed/)
  })

  it('counts the files it does not list', () => {
    const many = { ...blocked, differing: Array.from({ length: 20 }, (_, i) => `/f${String(i)}.js`), differingCount: 31 }
    const view = sheetView(many, 'ipfs://abc/', 't')
    expect(view.files).toHaveLength(MAX_LISTED_FILES)
    expect(view.more).toBe(`and ${String(31 - MAX_LISTED_FILES)} more`)
  })

  it('is plain news, with no warning and no Try again, for an app over the size Orivon allows', () => {
    const view = sheetView({ kind: 'too-large', name: 'Ledger' }, 'ipfs://abc/', 't')
    expect(view).toMatchObject({ kind: 'too-large', title: 'Ledger is too large', canRetry: false, files: [] })
    expect(view.title).not.toMatch(/security/i)
    expect(coverFor({ kind: 'too-large', name: 'Ledger' })).toMatchObject({ title: 'Ledger was not opened', busy: false })
  })

  it('names an invalid bundle by its reason, and lists no files', () => {
    const view = sheetView({ kind: 'blocked', name: 'Ledger', differing: [], differingCount: 0, rootMatches: true, invalid: 'asset fetch failed: HTTP 404 (/app.js)' }, 'a', 't')
    expect(view).toMatchObject({ files: [], canRetry: false, note: 'asset fetch failed: HTTP 404 (/app.js)' })
    expect(view.title).toMatch(/could not be verified/)
  })

  it('says the declared tree contradicts itself only when no file differs', () => {
    expect(sheetView({ ...blocked, rootMatches: false }, 'a', 't').body).not.toMatch(/contradict/i)
    const view = sheetView({ ...blocked, differing: [], differingCount: 0, rootMatches: false }, 'a', 't')
    expect(view.files).toEqual([])
    expect(view.body).toMatch(/contradict/i)
  })

  it('is a retry sheet for a download that failed, and says the permissions are kept', () => {
    const view = sheetView({ kind: 'download-failed', name: 'Ledger', reason: 'gateway answered 502' }, 'ipfs://abc/', 't')
    expect(view).toMatchObject({ kind: 'download-failed', canRetry: true, title: "Couldn't download Ledger" })
    expect(view.body).toMatch(/answer is kept/)
  })

  it('cuts the failure reason and the address to fit', () => {
    const view = sheetView({ kind: 'download-failed', name: 'L', reason: 'r'.repeat(900) }, 'a'.repeat(900), 't')
    expect(view.note.length).toBeLessThanOrEqual(160)
    expect(sheetView({ kind: 'download-failed', name: 'L', reason: 'asset app.js fetch failed: HTTP 502 (https://abc.ipfs.orivon/app.js)' }, 'a', 't').note).toBe('asset app.js fetch failed: HTTP 502')
    expect(view.address.length).toBeLessThanOrEqual(200)
  })
})
