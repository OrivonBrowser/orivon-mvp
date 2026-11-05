import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SiteRequest } from '../electron-names.js'
import type { SiteDecision } from '../site-settings-store.js'
import type { RestartReopens } from '../site-prompt-text.js'
import { addressAfterRestart, createWebGpuAsk, reopensAfterRestart, x11QuestionApplies, type X11State } from '../webgpu-ask.js'

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
}

function rig (options: Options = {}) {
  const tab = new EventEmitter()
  const request = vi.fn((_request: SiteRequest, _contents: EventEmitter | null, _details: object): Promise<boolean> | undefined =>
    'answer' in options && options.answer === undefined ? undefined : Promise.resolve(options.answer ?? true))
  const turnOnX11 = vi.fn(() => options.turnedOn ?? true)
  const offerRestart = vi.fn((_contents: EventEmitter, _reopens: RestartReopens) => {})
  const ask = createWebGpuAsk<EventEmitter>({
    request,
    isApp: (origin) => options.apps?.includes(origin) === true,
    blockedByDefault: () => options.blockedByDefault === true,
    stored: () => options.stored,
    isPrivate: options.isPrivate === true,
    x11: () => options.x11 ?? WITHOUT_MODE,
    turnOnX11,
    restoresSession: () => options.restoresSession === true,
    tabHasTunnel: () => options.tabHasTunnel === true,
    offerRestart
  })
  return { ask, tab, request, turnOnX11, offerRestart }
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

describe('a page with no web origin', () => {
  it.each(['', 'null', 'orivon://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'file://', 'about:blank'])('keeps the adapter Chromium gave it, unasked, for the origin %j', async (origin) => {
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
    expect(offerRestart).toHaveBeenCalledWith(tab, 'page')
  })

  it('turns nothing on and offers nothing after a block, a question closed without an answer or a page that moved on, which the engine all answers no', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: false })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it.each([
    ['reopens this page when nothing is restored', { restoresSession: false, tabHasTunnel: false }, 'page'],
    ['brings the session back when the start-up choice restores it', { restoresSession: true, tabHasTunnel: false }, 'session'],
    ['does not reopen a page whose tab holds a tunnel of its own, which a launch address would lose', { restoresSession: false, tabHasTunnel: true }, 'none'],
    ['leaves the tunnel to the restored session when both hold', { restoresSession: true, tabHasTunnel: true }, 'session']
  ] as const)('offers a restart that %s', async (_label, state, expected) => {
    const { ask, tab, offerRestart } = rig({ answer: true, ...state })
    await ask(tab, SITE, false)
    expect(offerRestart).toHaveBeenCalledTimes(1)
    expect(offerRestart).toHaveBeenCalledWith(tab, expected)
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

  it('offers one restart when the page asks twice while the question is open', async () => {
    const { ask, tab, offerRestart, turnOnX11 } = rig({ answer: true })
    expect(await Promise.all([ask(tab, SITE, false), ask(tab, SITE, false)])).toEqual([false, false])
    expect(turnOnX11).toHaveBeenCalledTimes(1)
    expect(offerRestart).toHaveBeenCalledTimes(1)
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

  it('reopens the page alone when nothing is restored and the tab has no tunnel of its own', () => {
    expect(reopensAfterRestart({ restoresSession: false, tabHasTunnel: false })).toBe('page')
  })

  it('reopens nothing when the tab has a tunnel of its own, which a launch address does not carry', () => {
    expect(reopensAfterRestart({ restoresSession: false, tabHasTunnel: true })).toBe('none')
  })
})

describe('addressAfterRestart', () => {
  it('names the page only for a start that reopens the page alone', () => {
    expect(addressAfterRestart('page', 'https://game.example/play')).toBe('https://game.example/play')
    expect(addressAfterRestart('session', 'https://game.example/play')).toBeUndefined()
    expect(addressAfterRestart('none', 'https://game.example/play')).toBeUndefined()
    expect(addressAfterRestart('page', undefined)).toBeUndefined()
  })
})
