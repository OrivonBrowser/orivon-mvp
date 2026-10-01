import { describe, expect, it, vi } from 'vitest'
import type { Certificate, WebContents } from 'electron'
import type { ShellWindow } from '../../shell/window-registry.js'
import { certificateItem, handleSelectClientCertificate } from '../client-certificate.js'
import type { ChooserSpec } from '../chooser-store.js'

const NOW = Date.UTC(2026, 9, 1)

function cert (name: string, issuer: string, expiry: number): Certificate {
  return { subjectName: name, issuerName: issuer, validExpiry: expiry / 1000, subject: { organizations: [] }, issuer: { organizations: [] } } as unknown as Certificate
}

const LIST = [cert('Alice', 'Test CA', NOW + 86_400_000), cert('Bob', 'Old CA', NOW - 86_400_000)]
const PAGE = { url: 'https://mtls.test:8443/' }
const TAB = { getURL: () => PAGE.url } as unknown as WebContents
const WINDOW = {} as ShellWindow

function run (over: { tab?: boolean, contents?: WebContents | null, list?: readonly Certificate[], answer?: Promise<string | null> } = {}): { prevented: boolean, callback: ReturnType<typeof vi.fn>, specs: ChooserSpec[], done: Promise<void> } {
  const specs: ChooserSpec[] = []
  const callback = vi.fn()
  let prevented = false
  const answer = over.answer ?? Promise.resolve('0')
  handleSelectClientCertificate({
    findTab: (contents) => contents === TAB && over.tab !== false ? { window: WINDOW, tabId: 't1' } : null,
    ask: async (_window, _tab, spec) => { specs.push(spec); return await answer },
    formatDate: (ms) => new Date(ms).toISOString().slice(0, 10),
    now: () => NOW
  }, { preventDefault: () => { prevented = true } }, over.contents === undefined ? TAB : over.contents, 'https://mtls.test:8443/path', over.list ?? LIST, callback)
  return { prevented, callback, specs, done: new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }
}

describe('handleSelectClientCertificate', () => {
  it('always holds back Electron\'s own pick', () => {
    expect(run({ contents: null }).prevented).toBe(true)
  })

  it('sends no certificate for a request with no tab, or a web contents that is not one', () => {
    const none = run({ contents: null })
    expect(none.callback).toHaveBeenCalledWith()
    expect(none.specs).toHaveLength(0)
    const other = run({ tab: false })
    expect(other.callback).toHaveBeenCalledWith()
    expect(other.specs).toHaveLength(0)
  })

  it('sends none when the list is empty', () => {
    const empty = run({ list: [] })
    expect(empty.callback).toHaveBeenCalledWith()
    expect(empty.specs).toHaveLength(0)
  })

  it('asks in the chooser with one row per certificate, and sends the one that was chosen', async () => {
    const s = run()
    expect(s.specs[0]).toMatchObject({ title: 'Choose a certificate', origin: 'mtls.test:8443', confirm: 'Use certificate', line: 'This site asks you to identify yourself with a certificate.', preselect: false })
    expect(s.specs[0]?.warning).toBeUndefined()
    expect(s.specs[0]?.items).toEqual([
      { id: '0', title: 'Alice', sub: 'Issued by Test CA', meta: 'Expires 2026-10-02', expired: false },
      { id: '1', title: 'Bob', sub: 'Issued by Old CA', meta: 'Expired 2026-09-30', expired: true }
    ])
    await s.done
    expect(s.callback).toHaveBeenCalledWith(LIST[0])
  })

  it('lists an expired certificate after the valid ones and keeps the place Electron gave it', async () => {
    const s = run({ list: [LIST[1] as Certificate, LIST[0] as Certificate], answer: Promise.resolve('1') })
    expect(s.specs[0]?.items.map((item) => [item.id, item.title])).toEqual([['1', 'Alice'], ['0', 'Bob']])
    await s.done
    expect(s.callback).toHaveBeenCalledWith(LIST[0])
  })

  it('warns when the request comes from another site than the page the person is on', () => {
    PAGE.url = 'https://evil.example/'
    try {
      expect(run().specs[0]?.warning).toBe('This request comes from mtls.test:8443, not from the page you are on.')
    } finally {
      PAGE.url = 'https://mtls.test:8443/'
    }
  })

  it('sends none when the sheet was cancelled, or answered with an index that was not offered', async () => {
    for (const answer of [null, '5', '-1', 'x', '0; drop', '99999']) {
      const s = run({ answer: Promise.resolve(answer) })
      await s.done
      expect(s.callback, String(answer)).toHaveBeenCalledWith()
    }
  })

  it('sends none when asking fails', async () => {
    const s = run({ answer: Promise.reject(new Error('no')) })
    await s.done
    expect(s.callback).toHaveBeenCalledWith()
  })
})

describe('certificateItem', () => {
  it('falls back to the organisation when the name is empty', () => {
    const certificate = { subjectName: '', issuerName: '', validExpiry: NOW / 1000 + 10, subject: { organizations: ['Acme'] }, issuer: { organizations: [] } } as unknown as Certificate
    expect(certificateItem(certificate, 3, { formatDate: () => 'D', now: () => NOW })).toEqual({ id: '3', title: 'Acme', sub: 'Issued by an unknown issuer', meta: 'Expires D', expired: false })
  })
})
