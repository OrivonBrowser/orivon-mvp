import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SiteRequest } from '../electron-names.js'
import type { SiteDecision } from '../site-settings-store.js'
import { addressAfterRestart, createWebGpuAsk, reopensAfterRestart, x11QuestionApplies, type RestartOffer, type X11State } from '../webgpu-ask.js'

const SITE = 'https://game.example'
const ENGINE_REQUEST: SiteRequest = { kinds: ['webgpu'], sysex: false }
const MAIN = { isMainFrame: true, requestingUrl: SITE }

const WITHOUT_MODE: X11State = { offered: true, onAtStart: false, reverted: false }

interface Options {
  /** What the engine answers; undefined is a contents that is no ordinary tab. */
  answer?: boolean | undefined
  apps?: string[]
  blockedByDefault?: boolean
  stored?: SiteDecision
  isPrivate?: boolean
  x11?: X11State
  turnedOn?: boolean
  restoresSession?: boolean
  tabHasTunnel?: boolean
  /** The address the tab shows when Restart is pressed. */
  page?: string
}

function rig (options: Options = {}) {
  const tab = new EventEmitter()
  /** What the person's settings and the tab hold now: a test changes them between the offer and the press. */
  const now = { restoresSession: options.restoresSession === true, tabHasTunnel: options.tabHasTunnel === true, page: options.page as string | undefined }
  const request = vi.fn((_request: SiteRequest, _contents: EventEmitter | null, _details: object): Promise<boolean> | undefined =>
    'answer' in options && options.answer === undefined ? undefined : Promise.resolve(options.answer ?? true))
  const turnOnX11 = vi.fn(() => options.turnedOn ?? true)
  /** The tabs whose restart offer is up, which ends when a test takes the tab out. */
  const open = new Set<EventEmitter>()
  const offerRestart = vi.fn((contents: EventEmitter, _offer: RestartOffer) => { open.add(contents) })
  const ask = createWebGpuAsk<EventEmitter>({
    request,
    isApp: (origin) => options.apps?.includes(origin) === true,
    blockedByDefault: () => options.blockedByDefault === true,
    stored: () => options.stored,
    isPrivate: options.isPrivate === true,
    x11: () => options.x11 ?? WITHOUT_MODE,
    turnOnX11,
    restoresSession: () => now.restoresSession,
    tabHasTunnel: () => now.tabHasTunnel,
    pageOf: () => now.page,
    restartOffered: (contents) => open.has(contents),
    offerRestart
  })
  /** What the restart opens if it is pressed now, from the offer the page's grant made. */
  const addressNow = (): string | undefined => offerRestart.mock.calls[0]?.[1].address()
  return { ask, tab, request, turnOnX11, offerRestart, now, addressNow, open }
}

describe('where an adapter exists', () => {
  it('hands the engine one request for the WebGPU kind from the page\'s main frame, and gives the page its answer', async () => {
    const yes = rig({ answer: true })
    expect(await yes.ask(yes.tab, SITE, true)).toBe(true)
    expect(yes.request).toHaveBeenCalledWith(ENGINE_REQUEST, yes.tab, MAIN)
    const no = rig({ answer: false })
    expect(await no.ask(no.tab, SITE, true)).toBe(false)
  })

  it('reads the site from the frame\'s origin, whatever else is written after it', async () => {
    const { ask, tab, request } = rig()
    await ask(tab, 'https://game.example:8443', true)
    expect(request).toHaveBeenCalledWith(ENGINE_REQUEST, tab, { isMainFrame: true, requestingUrl: 'https://game.example:8443' })
  })

  it('never restarts anything, whatever the X11 state is', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: true })
    await ask(tab, SITE, true)
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('refuses a contents the engine does not speak for', async () => {
    const { ask, tab } = rig({ answer: undefined })
    expect(await ask(tab, SITE, true)).toBe(false)
  })
})

describe('a page with an opaque origin', () => {
  it('is refused without a question, with an adapter or without, as Chromium refuses every permission to an opaque origin: a site cannot opt out of the question by sandboxing its own document', async () => {
    const { ask, tab, request, turnOnX11, offerRestart } = rig({ answer: true })
    expect(await ask(tab, 'null', true)).toBe(false)
    expect(await ask(tab, 'null', false)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('is refused even where the X11 question applies and the site has a stored allow', async () => {
    const { ask, tab, request } = rig({ answer: true, stored: 'allow' })
    expect(await ask(tab, 'null', false)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('a page with a real origin that is not a website', () => {
  it.each(['', 'orivon://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'file://', 'about:blank'])('keeps the adapter Chromium gave it, unasked, for the origin %j', async (origin) => {
    const { ask, tab, request, turnOnX11, offerRestart } = rig()
    expect(await ask(tab, origin, true)).toBe(true)
    expect(await ask(tab, origin, false)).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })
})

describe('a decentralised site', () => {
  it.each([
    'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon',
    'https://k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8.ipns.orivon',
    'https://ca1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b.bzz.orivon',
    'https://vitalik.eth',
    'https://app.vitalik.eth:8443'
  ])('is asked as a website is, because it is served over https at an origin of its own: %s', async (origin) => {
    const { ask, tab, request } = rig({ answer: true })
    expect(await ask(tab, origin, true)).toBe(true)
    expect(request).toHaveBeenCalledWith(ENGINE_REQUEST, tab, { isMainFrame: true, requestingUrl: expect.stringMatching(/^https:\/\/[^/]+$/) as string })
  })
})

describe('an origin that holds grants', () => {
  it('is told yes without a question, with an adapter or without', async () => {
    const { ask, tab, request, turnOnX11 } = rig({ apps: [SITE] })
    expect(await ask(tab, SITE, true)).toBe(true)
    expect(await ask(tab, SITE, false)).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(turnOnX11).not.toHaveBeenCalled()
  })
})

describe('an origin that holds grants, under a default of Block', () => {
  it('is refused without a question, with an adapter or without, because the person\'s own block still wins', async () => {
    const { ask, tab, request, offerRestart } = rig({ apps: [SITE], blockedByDefault: true })
    expect(await ask(tab, SITE, true)).toBe(false)
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('does not change a website: the engine applies the default to it, as to every site with no answer', async () => {
    const { ask, tab, request } = rig({ blockedByDefault: true, answer: false })
    expect(await ask(tab, SITE, true)).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('a private window with an adapter to give', () => {
  it('is asked, as every window is, and the engine keeps the answer in memory there', async () => {
    const { ask, tab, request } = rig({ isPrivate: true, answer: true })
    expect(await ask(tab, SITE, true)).toBe(true)
    expect(request).toHaveBeenCalledWith(ENGINE_REQUEST, tab, MAIN)
  })
})

describe('where Chromium gave no adapter', () => {
  it('asks nobody and says no when the X11 question does not apply', async () => {
    for (const x11 of [{ ...WITHOUT_MODE, offered: false }, { ...WITHOUT_MODE, onAtStart: true }, { ...WITHOUT_MODE, reverted: true }]) {
      const { ask, tab, request } = rig({ x11 })
      expect(await ask(tab, SITE, false)).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
    const privateSession = rig({ isPrivate: true })
    expect(await privateSession.ask(privateSession.tab, SITE, false)).toBe(false)
    expect(privateSession.request).not.toHaveBeenCalled()
  })

  it('asks with the restart flag on an X11 session whose run did not start in the mode, and on a grant turns the mode on and then offers the restart', async () => {
    const order: string[] = []
    const { ask, tab, request, turnOnX11, offerRestart } = rig({ answer: true })
    turnOnX11.mockImplementation(() => { order.push('setting'); return true })
    offerRestart.mockImplementation(() => { order.push('offer') })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(request).toHaveBeenCalledWith({ ...ENGINE_REQUEST, restart: true }, tab, MAIN)
    expect(order).toEqual(['setting', 'offer'])
    expect(offerRestart).toHaveBeenCalledWith(tab, { reopens: 'site', address: expect.any(Function) as () => string | undefined })
  })

  it('turns nothing on and offers nothing after a block, a question closed without an answer or a page that moved on, which the engine all answers no', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: false })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it.each([
    ['reopens the site when nothing is restored', { restoresSession: false, tabHasTunnel: false }, 'site'],
    ['brings the session back when the start-up choice restores it', { restoresSession: true, tabHasTunnel: false }, 'session'],
    ['does not reopen a site whose tab holds a tunnel of its own, which a launch address would lose', { restoresSession: false, tabHasTunnel: true }, 'none'],
    ['leaves the tunnel to the restored session when both hold', { restoresSession: true, tabHasTunnel: true }, 'session']
  ] as const)('offers a restart that %s', async (_label, state, expected) => {
    const { ask, tab, offerRestart } = rig({ answer: true, ...state })
    await ask(tab, SITE, false)
    expect(offerRestart).toHaveBeenCalledTimes(1)
    expect(offerRestart.mock.calls[0]?.[1].reopens).toBe(expected)
  })

  it('offers no restart when the setting could not be turned on', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: true, turnedOn: false })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(turnOnX11).toHaveBeenCalledTimes(1)
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('does not ask again a site that has an answer, so a mode turned off in Settings stays off', async () => {
    for (const stored of ['allow', 'block'] as const) {
      const { ask, tab, turnOnX11, offerRestart } = rig({ stored })
      expect(await ask(tab, SITE, false)).toBe(false)
      expect(turnOnX11).not.toHaveBeenCalled()
      expect(offerRestart).not.toHaveBeenCalled()
    }
  })

  it('still lets the engine read the stored answer, which it notes for the address bar\'s chip and the site popup, and asks it with no restart flag', async () => {
    for (const stored of ['allow', 'block'] as const) {
      for (const x11 of [WITHOUT_MODE, { ...WITHOUT_MODE, offered: false }, { ...WITHOUT_MODE, onAtStart: true }]) {
        const { ask, tab, request } = rig({ stored, x11, answer: stored === 'allow' })
        expect(await ask(tab, SITE, false)).toBe(false)
        expect(request).toHaveBeenCalledTimes(1)
        expect(request).toHaveBeenCalledWith(ENGINE_REQUEST, tab, MAIN)
      }
    }
  })

  it('answers no after a stored answer even when the engine does not speak for the contents', async () => {
    const { ask, tab } = rig({ stored: 'allow', answer: undefined })
    expect(await ask(tab, SITE, false)).toBe(false)
  })

  it('asks the engine nothing when nothing is stored and the X11 question does not apply', async () => {
    const { ask, tab, request } = rig({ x11: { ...WITHOUT_MODE, offered: false } })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('offers one restart and changes the setting once when the page asks twice while the question is open', async () => {
    const { ask, tab, offerRestart, turnOnX11 } = rig({ answer: true })
    expect(await Promise.all([ask(tab, SITE, false), ask(tab, SITE, false)])).toEqual([false, false])
    expect(turnOnX11).toHaveBeenCalledTimes(1)
    expect(offerRestart).toHaveBeenCalledTimes(1)
  })

  it('makes no second offer, and changes nothing again, for a tab whose offer is still up', async () => {
    const { ask, tab, offerRestart, turnOnX11 } = rig({ answer: true })
    await ask(tab, SITE, false)
    await ask(tab, SITE, false)
    await ask(tab, 'https://other.example', false)
    expect(turnOnX11).toHaveBeenCalledTimes(1)
    expect(offerRestart).toHaveBeenCalledTimes(1)
  })

  it('offers again for the same site in the same tab once the offer ended, as a later grant (the answer was reset, say) turns the mode on and offers a restart', async () => {
    const { ask, tab, offerRestart, turnOnX11, open } = rig({ answer: true })
    await ask(tab, SITE, false)
    open.delete(tab)
    await ask(tab, SITE, false)
    expect(turnOnX11).toHaveBeenCalledTimes(2)
    expect(offerRestart).toHaveBeenCalledTimes(2)
  })

  it('keeps an offer per tab, not one for them all', async () => {
    const one = rig({ answer: true })
    const other = new EventEmitter()
    await one.ask(one.tab, SITE, false)
    await one.ask(other, SITE, false)
    expect(one.offerRestart).toHaveBeenCalledTimes(2)
  })
})

describe('what the restart reopens, decided when it is pressed', () => {
  const PAGE = 'https://game.example/play/level-2'

  it('opens the page the tab is on then, not the one that was asked', async () => {
    const { ask, tab, now, addressNow } = rig({ answer: true, page: 'https://game.example/play' })
    await ask(tab, SITE, false)
    expect(addressNow()).toBe('https://game.example/play')
    now.page = PAGE
    expect(addressNow()).toBe(PAGE)
    now.page = undefined
    expect(addressNow()).toBeUndefined()
  })

  it('opens nothing when the tab was given a tunnel of its own after the offer was made', async () => {
    const { ask, tab, now, offerRestart, addressNow } = rig({ answer: true, page: PAGE })
    await ask(tab, SITE, false)
    expect(offerRestart.mock.calls[0]?.[1].reopens).toBe('site')
    expect(addressNow()).toBe(PAGE)
    now.tabHasTunnel = true
    expect(addressNow()).toBeUndefined()
  })

  it('opens nothing when the start-up choice was changed to restore the session after the offer was made, which brings the page back by itself', async () => {
    const { ask, tab, now, addressNow } = rig({ answer: true, page: PAGE })
    await ask(tab, SITE, false)
    now.restoresSession = true
    expect(addressNow()).toBeUndefined()
  })

  it('keeps the wording it was shown with, whatever changes', async () => {
    const { ask, tab, now, offerRestart } = rig({ answer: true, page: PAGE })
    await ask(tab, SITE, false)
    now.tabHasTunnel = true
    now.restoresSession = true
    expect(offerRestart.mock.calls[0]?.[1].reopens).toBe('site')
  })

  it('opens the page when neither says not to, even if the offer said nothing of it', async () => {
    const { ask, tab, now, offerRestart, addressNow } = rig({ answer: true, tabHasTunnel: true, page: PAGE })
    await ask(tab, SITE, false)
    expect(offerRestart.mock.calls[0]?.[1].reopens).toBe('none')
    expect(addressNow()).toBeUndefined()
    now.tabHasTunnel = false
    expect(addressNow()).toBe(PAGE)
  })
})

describe('x11QuestionApplies', () => {
  it('holds only on an X11 session whose run did not start in the mode, which the guard has not turned off, outside a private session', () => {
    expect(x11QuestionApplies(WITHOUT_MODE, false)).toBe(true)
    expect(x11QuestionApplies({ ...WITHOUT_MODE, offered: false }, false)).toBe(false)
    expect(x11QuestionApplies({ ...WITHOUT_MODE, onAtStart: true }, false)).toBe(false)
    expect(x11QuestionApplies({ ...WITHOUT_MODE, reverted: true }, false)).toBe(false)
    expect(x11QuestionApplies(WITHOUT_MODE, true)).toBe(false)
  })
})

describe('reopensAfterRestart', () => {
  it('brings the saved session back when the start-up choice restores it, whatever the tab carries', () => {
    expect(reopensAfterRestart({ restoresSession: true, tabHasTunnel: false })).toBe('session')
    expect(reopensAfterRestart({ restoresSession: true, tabHasTunnel: true })).toBe('session')
  })

  it('reopens the site alone when nothing is restored and the tab has no tunnel of its own', () => {
    expect(reopensAfterRestart({ restoresSession: false, tabHasTunnel: false })).toBe('site')
  })

  it('reopens nothing when the tab has a tunnel of its own, which a launch address does not carry', () => {
    expect(reopensAfterRestart({ restoresSession: false, tabHasTunnel: true })).toBe('none')
  })
})

describe('addressAfterRestart', () => {
  it('names the page only for a start that reopens the site alone', () => {
    expect(addressAfterRestart('site', 'https://game.example/play')).toBe('https://game.example/play')
    expect(addressAfterRestart('session', 'https://game.example/play')).toBeUndefined()
    expect(addressAfterRestart('none', 'https://game.example/play')).toBeUndefined()
    expect(addressAfterRestart('site', undefined)).toBeUndefined()
  })
})
