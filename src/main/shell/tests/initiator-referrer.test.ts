import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { NAVIGATION_NOTE_CHANNEL as PRELOAD_SIDE_CHANNEL } from '../../../preload/navigation-source.js'

const { ipcOn } = vi.hoisted(() => ({ ipcOn: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on: ipcOn } }))
const policyHeaderOf = vi.fn((_contents: unknown, _documentUrl: string): string | undefined => '')
vi.mock('../page-referrer-policy.js', () => ({ referrerPolicyHeaderOf: policyHeaderOf }))
const { NAVIGATION_NOTE_CHANNEL, installNavigationNotes, referrerOfInitiator, takeNavigationNote, topInitiatorUrl } = await import('../initiator-referrer.js')

const SOURCE = 'https://a.eth/page'
const TARGET = 'https://b.eth/landing'
const note = (extra: object = {}): object => ({ href: SOURCE, documentUrl: SOURCE, metaPolicies: [], destination: TARGET, source: { kind: 'script' }, ...extra })
const tab = (): WebContents => ({ mainFrame: { top: true } }) as unknown as WebContents
const topOf = (wc: WebContents): unknown => (wc as unknown as { mainFrame: unknown }).mainFrame

beforeEach(() => { policyHeaderOf.mockReset().mockReturnValue('') })

describe('the note a tab sends', () => {
  it('is received on the channel the preload sends it on', () => {
    expect(NAVIGATION_NOTE_CHANNEL).toBe(PRELOAD_SIDE_CHANNEL)
    ipcOn.mockClear()
    installNavigationNotes.install({} as never, {} as never, {} as never, {} as never)
    expect(ipcOn).toHaveBeenCalledWith(NAVIGATION_NOTE_CHANNEL, expect.any(Function))
  })

  it('is used by the navigation it describes, with the policy the document came with', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note())
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toEqual({ url: SOURCE, policy: 'default' })
    expect(policyHeaderOf).toHaveBeenCalledWith(wc, SOURCE)
  })

  it('looks the header up under the address the document was loaded at', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note({ documentUrl: 'https://a.eth/first' }))
    referrerOfInitiator(wc, SOURCE, TARGET)
    expect(policyHeaderOf).toHaveBeenCalledWith(wc, 'https://a.eth/first')
  })

  it('sends none when the response was not seen, or its header forbids it', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note())
    policyHeaderOf.mockReturnValue(undefined)
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
    policyHeaderOf.mockReturnValue('no-referrer')
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
  })

  it('keeps the newest note of a tab, and each tab apart', () => {
    const first = tab()
    const second = tab()
    takeNavigationNote(first, topOf(first), note({ destination: 'https://c.eth/' }))
    takeNavigationNote(first, topOf(first), note())
    expect(referrerOfInitiator(first, SOURCE, TARGET)).toEqual({ url: SOURCE, policy: 'default' })
    expect(referrerOfInitiator(second, SOURCE, TARGET)).toBeUndefined()
  })

  it('is ignored when it came from a frame that is not the tab\'s top frame, or from none', () => {
    const wc = tab()
    takeNavigationNote(wc, { top: false }, note())
    takeNavigationNote(wc, null, note())
    takeNavigationNote(wc, undefined, note())
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
  })

  it.each([undefined, null, 'garbage', 4, [], { href: 1 }])('is dropped when it is %j', (payload) => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), payload)
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
  })
})

describe('referrerOfInitiator', () => {
  it('asks nobody when no top frame started the navigation', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note())
    expect(referrerOfInitiator(wc, undefined, TARGET)).toBeUndefined()
  })

  it('sends none when the note is about another navigation, or about another document than the one that started this', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note({ destination: 'https://c.eth/' }))
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
    takeNavigationNote(wc, topOf(wc), note({ href: 'https://a.eth/other' }))
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
  })

  it('sends none, never throws, when working the referrer out fails', () => {
    const wc = tab()
    takeNavigationNote(wc, topOf(wc), note())
    policyHeaderOf.mockImplementation(() => { throw new Error('boom') })
    expect(referrerOfInitiator(wc, SOURCE, TARGET)).toBeUndefined()
  })
})

describe('topInitiatorUrl', () => {
  it('is the address of the top frame that started the navigation, and nothing for a subframe or no frame', () => {
    expect(topInitiatorUrl({ url: SOURCE, parent: null })).toBe(SOURCE)
    expect(topInitiatorUrl({ url: SOURCE, parent: {} })).toBeUndefined()
    expect(topInitiatorUrl(null)).toBeUndefined()
    expect(topInitiatorUrl(undefined)).toBeUndefined()
  })
})
