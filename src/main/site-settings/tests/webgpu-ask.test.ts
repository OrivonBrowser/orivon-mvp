import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SiteRequest } from '../electron-names.js'
import type { SiteDecision } from '../site-settings-store.js'
import { createWebGpuAsk, x11QuestionApplies, type X11State } from '../webgpu-ask.js'

const SITE = 'https://game.example'
const ENGINE_REQUEST: SiteRequest = { kinds: ['webgpu'], sysex: false }
const MAIN = { isMainFrame: true, requestingUrl: SITE }

const WITHOUT_MODE: X11State = { offered: true, onAtStart: false, reverted: false }

interface Options {
  /** What the engine answers; undefined is a contents that is no ordinary tab. */
  answer?: boolean | undefined
  apps?: string[]
  stored?: SiteDecision
  isPrivate?: boolean
  x11?: X11State
  turnedOn?: boolean
}

function rig (options: Options = {}) {
  const tab = new EventEmitter()
  const request = vi.fn((_request: SiteRequest, _contents: EventEmitter | null, _details: object): Promise<boolean> | undefined =>
    'answer' in options && options.answer === undefined ? undefined : Promise.resolve(options.answer ?? true))
  const turnOnX11 = vi.fn(() => options.turnedOn ?? true)
  const offerRestart = vi.fn((_contents: EventEmitter) => {})
  const ask = createWebGpuAsk<EventEmitter>({
    request,
    isApp: (origin) => options.apps?.includes(origin) === true,
    stored: () => options.stored,
    isPrivate: options.isPrivate === true,
    x11: () => options.x11 ?? WITHOUT_MODE,
    turnOnX11,
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

describe('an origin that is not a website, or that holds grants', () => {
  it.each(['', 'null', 'orivon://settings', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'file://', 'about:blank'])('is refused %j without asking', async (origin) => {
    const { ask, tab, request, offerRestart } = rig()
    expect(await ask(tab, origin, true)).toBe(false)
    expect(await ask(tab, origin, false)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('is told yes without a question, with an adapter or without', async () => {
    const { ask, tab, request, turnOnX11 } = rig({ apps: [SITE] })
    expect(await ask(tab, SITE, true)).toBe(true)
    expect(await ask(tab, SITE, false)).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(turnOnX11).not.toHaveBeenCalled()
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
    expect(offerRestart).toHaveBeenCalledWith(tab)
  })

  it('turns nothing on and offers nothing after a block, a question closed without an answer or a page that moved on, which the engine all answers no', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: false })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(turnOnX11).not.toHaveBeenCalled()
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('offers no restart when the setting could not be turned on', async () => {
    const { ask, tab, turnOnX11, offerRestart } = rig({ answer: true, turnedOn: false })
    expect(await ask(tab, SITE, false)).toBe(false)
    expect(turnOnX11).toHaveBeenCalledTimes(1)
    expect(offerRestart).not.toHaveBeenCalled()
  })

  it('does not ask again a site that has an answer, so a mode turned off in Settings stays off', async () => {
    for (const stored of ['allow', 'block'] as const) {
      const { ask, tab, request, turnOnX11, offerRestart } = rig({ stored })
      expect(await ask(tab, SITE, false)).toBe(false)
      expect(request).not.toHaveBeenCalled()
      expect(turnOnX11).not.toHaveBeenCalled()
      expect(offerRestart).not.toHaveBeenCalled()
    }
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
