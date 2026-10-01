import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SiteRequest } from '../electron-names.js'
import type { SiteKind } from '../kinds.js'
import { PageAccess } from '../page-access.js'
import { createSiteAsksEngine, type SiteAnswer } from '../site-asks-engine.js'
import { SiteSettingsStore } from '../site-settings-store.js'

const SITE = 'https://meet.example'

class FakeTab extends EventEmitter {
  constructor (public url = `${SITE}/room`) { super() }
  getURL (): string { return this.url }
}

const CAMERA: SiteRequest = { kinds: ['camera'], sysex: false }
const BOTH: SiteRequest = { kinds: ['camera', 'microphone'], sysex: false }
const MAIN = { isMainFrame: true, requestingUrl: `${SITE}/room` }

interface Options { answer?: SiteAnswer, defaults?: Partial<Record<SiteKind, 'ask' | 'block'>>, apps?: string[], showing?: boolean, isTab?: boolean }

function rig (options: Options = {}) {
  const store = new SiteSettingsStore(null)
  const access = new PageAccess<FakeTab>()
  const ask = vi.fn(async (_kinds: readonly SiteKind[], _tab: FakeTab, _request: { sysex: boolean }): Promise<SiteAnswer> => options.answer ?? 'allow')
  const engine = createSiteAsksEngine<FakeTab>({
    store,
    defaultFor: (kind) => options.defaults?.[kind] ?? 'ask',
    isTab: () => options.isTab ?? true,
    urlOf: (tab) => tab.getURL(),
    isApp: (origin) => options.apps?.includes(origin) === true,
    showing: () => options.showing ?? true,
    ask,
    access
  })
  return { engine, store, access, ask, tab: new FakeTab() }
}

describe('request', () => {
  it('asks the person, stores an allow, and tells the page yes', async () => {
    const { engine, store, access, ask, tab } = rig({ answer: 'allow' })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(true)
    expect(ask).toHaveBeenCalledWith(['camera'], tab, { sysex: false })
    expect(store.get(SITE, 'camera')).toBe('allow')
    expect(access.entries(tab)).toEqual([{ kind: 'camera', state: 'allowed' }])
  })

  it('remembers an allow for a kind with no service behind it and still tells the page no', async () => {
    const LOCATION: SiteRequest = { kinds: ['location'], sysex: false }
    const { engine, store, ask, tab } = rig({ answer: 'allow' })
    expect(await engine.request(LOCATION, tab, MAIN)).toBe(false)
    expect(store.get(SITE, 'location')).toBe('allow')
    expect(await engine.request(LOCATION, tab, MAIN)).toBe(false)
    expect(await engine.request(LOCATION, tab, { isMainFrame: false, requestingUrl: `${SITE}/f` })).toBe(false)
    expect(engine.check('location', tab, SITE, { isMainFrame: true })).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('stores a block, tells the page no, and marks the page blocked', async () => {
    const { engine, store, access, tab } = rig({ answer: 'block' })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(store.get(SITE, 'camera')).toBe('block')
    expect(access.entries(tab)).toEqual([{ kind: 'camera', state: 'blocked' }])
  })

  it('answers from a stored decision without asking', async () => {
    const { engine, store, ask, tab } = rig()
    store.set(SITE, 'camera', 'allow')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(true)
    store.set(SITE, 'camera', 'block')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks once for camera and microphone together, and stores each', async () => {
    const { engine, store, ask, tab } = rig({ answer: 'allow' })
    expect(await engine.request(BOTH, tab, { ...MAIN, securityOrigin: SITE })).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith(['camera', 'microphone'], tab, { sysex: false })
    expect(store.get(SITE, 'camera')).toBe('allow')
    expect(store.get(SITE, 'microphone')).toBe('allow')
  })

  it('asks only for the half that is undecided', async () => {
    const { engine, store, ask, tab } = rig({ answer: 'allow' })
    store.set(SITE, 'camera', 'allow')
    expect(await engine.request(BOTH, tab, MAIN)).toBe(true)
    expect(ask).toHaveBeenCalledWith(['microphone'], tab, { sysex: false })
  })

  it('refuses without asking when one half is already blocked', async () => {
    const { engine, store, ask, tab } = rig()
    store.set(SITE, 'microphone', 'block')
    expect(await engine.request(BOTH, tab, MAIN)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses without asking and marks the page blocked when the default for the kind is block', async () => {
    const { engine, store, access, ask, tab } = rig({ defaults: { location: 'block' } })
    expect(await engine.request({ kinds: ['location'], sysex: false }, tab, MAIN)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(store.get(SITE, 'location')).toBeUndefined()
    expect(access.entries(tab)).toEqual([{ kind: 'location', state: 'blocked' }])
  })

  it('a stored allow beats a default of block', async () => {
    const { engine, store, tab } = rig({ defaults: { camera: 'block' } })
    store.set(SITE, 'camera', 'allow')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(true)
  })

  it('treats closing the prompt as no answer: nothing stored, and the page is not asked again until it loads again', async () => {
    const { engine, store, access, ask, tab } = rig({ answer: 'dismiss' })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(store.get(SITE, 'camera')).toBeUndefined()
    expect(access.entries(tab)).toEqual([])
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    tab.emit('did-navigate')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('takes a prompt that fails as closing it', async () => {
    const { engine, ask, store, tab } = rig()
    ask.mockRejectedValue(new Error('window gone'))
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(store.get(SITE, 'camera')).toBeUndefined()
  })

  it('stores nothing when the tab moved to another site while the question was open', async () => {
    const { engine, store, access, ask, tab } = rig()
    ask.mockImplementation(async () => { tab.url = 'https://elsewhere.example/'; return 'allow' })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(store.entries()).toEqual([])
    expect(access.entries(tab)).toEqual([])
  })

  it('decides nothing when the same page was loaded again while the question was open', async () => {
    const { engine, store, access, ask, tab } = rig()
    ask.mockImplementation(async () => { tab.emit('did-navigate'); return 'dismiss' })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    // The new page is asked afresh: the dismissal belonged to the old one.
    ask.mockImplementation(async () => 'allow')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(true)
    expect(store.get(SITE, 'camera')).toBe('allow')
    expect(access.wasDismissed(tab, SITE, 'camera')).toBe(false)
  })

  it('refuses without asking for a tab that is not on screen', async () => {
    const { engine, ask, tab } = rig({ showing: false })
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('still answers a background tab from a stored allow', async () => {
    const { engine, store, tab } = rig({ showing: false })
    store.set(SITE, 'camera', 'allow')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(true)
  })

  it('answers undefined for contents that are not a tab, and for none', () => {
    const { engine, tab } = rig({ isTab: false })
    expect(engine.request(CAMERA, tab, MAIN)).toBeUndefined()
    expect(rig().engine.request(CAMERA, null, MAIN)).toBeUndefined()
  })

  it('refuses a registered app\'s origin, even with a stored allow', async () => {
    const { engine, store, ask, tab } = rig({ apps: [SITE] })
    store.set(SITE, 'camera', 'allow')
    expect(await engine.request(CAMERA, tab, MAIN)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it.each([
    ['an extension page', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html'],
    ['a shell page', 'orivon://settings/'],
    ['a file', 'file:///home/person/index.html'],
    ['no address', '']
  ])('refuses %s: it is not a website', async (_name, url) => {
    const { engine, ask, tab } = rig()
    tab.url = url
    expect(await engine.request(CAMERA, tab, { isMainFrame: true, requestingUrl: url })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses a request that does not come from the page the tab shows', async () => {
    const { engine, store, ask, tab } = rig()
    store.set('https://other.example', 'camera', 'allow')
    expect(await engine.request(CAMERA, tab, { isMainFrame: true, requestingUrl: 'https://other.example/' })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  describe('frames', () => {
    it('never asks from a frame, and gives a same-origin frame the page\'s stored allow only', async () => {
      const { engine, store, ask, tab } = rig()
      const frame = { isMainFrame: false, requestingUrl: `${SITE}/embed` }
      expect(await engine.request(CAMERA, tab, frame)).toBe(false)
      store.set(SITE, 'camera', 'allow')
      expect(await engine.request(CAMERA, tab, frame)).toBe(true)
      expect(ask).not.toHaveBeenCalled()
    })

    it('refuses a cross-origin frame even when its own origin is allowed elsewhere', async () => {
      const { engine, store, tab } = rig()
      store.set('https://ads.example', 'camera', 'allow')
      store.set(SITE, 'camera', 'allow')
      expect(await engine.request(CAMERA, tab, { isMainFrame: false, requestingUrl: 'https://ads.example/x' })).toBe(false)
    })

    it('names a media frame by its security origin', async () => {
      const { engine, store, tab } = rig()
      store.set(SITE, 'camera', 'allow')
      expect(await engine.request(CAMERA, tab, { isMainFrame: false, securityOrigin: 'https://ads.example/', requestingUrl: `${SITE}/embed` })).toBe(false)
    })
  })

  it('shares one question between two identical requests made while it is open', async () => {
    const { engine, ask, tab } = rig()
    let answer: (value: SiteAnswer) => void = () => {}
    ask.mockImplementation(async () => await new Promise<SiteAnswer>((resolve) => { answer = resolve }))
    const first = engine.request(CAMERA, tab, MAIN)
    const second = engine.request(CAMERA, tab, MAIN)
    await Promise.resolve()
    answer('allow')
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('carries the MIDI wording through to the prompt', async () => {
    const { engine, ask, tab } = rig()
    await engine.request({ kinds: ['midi'], sysex: true }, tab, MAIN)
    expect(ask).toHaveBeenCalledWith(['midi'], tab, { sysex: true })
  })
})

describe('check', () => {
  const CHECK = { isMainFrame: true }

  it('is true only for a stored allow', () => {
    const { engine, store, tab } = rig()
    expect(engine.check('camera', tab, SITE, CHECK)).toBe(false)
    store.set(SITE, 'camera', 'block')
    expect(engine.check('camera', tab, SITE, CHECK)).toBe(false)
    store.set(SITE, 'camera', 'allow')
    expect(engine.check('camera', tab, SITE, CHECK)).toBe(true)
    expect(engine.check('microphone', tab, SITE, CHECK)).toBe(false)
  })

  it('never asks, never stores, and ignores the default', () => {
    const { engine, store, ask, tab } = rig({ defaults: { camera: 'block' } })
    engine.check('camera', tab, SITE, CHECK)
    expect(ask).not.toHaveBeenCalled()
    expect(store.entries()).toEqual([])
  })

  it('refuses a cross-origin frame, which names the page that embeds it', () => {
    const { engine, store, tab } = rig()
    store.set('https://ads.example', 'camera', 'allow')
    store.set(SITE, 'camera', 'allow')
    expect(engine.check('camera', tab, 'https://ads.example', { isMainFrame: false, embeddingOrigin: SITE })).toBe(false)
    expect(engine.check('camera', tab, SITE, { isMainFrame: false, embeddingOrigin: 'https://ads.example' })).toBe(false)
  })

  it('refuses a media check about another origin than the page, which a cross-origin frame in an allowed page makes', () => {
    const { engine, store, tab } = rig()
    store.set(SITE, 'camera', 'allow')
    expect(engine.check('camera', tab, SITE, { isMainFrame: true, securityOrigin: 'https://ads.example/' })).toBe(false)
    expect(engine.check('camera', tab, SITE, { isMainFrame: true, securityOrigin: `${SITE}/` })).toBe(true)
  })

  it('gives a same-origin frame the page\'s answer, and refuses a frame on another site than the tab\'s', () => {
    const { engine, store, tab } = rig()
    store.set(SITE, 'camera', 'allow')
    store.set('https://ads.example', 'camera', 'allow')
    expect(engine.check('camera', tab, SITE, { isMainFrame: false })).toBe(true)
    expect(engine.check('camera', tab, 'https://ads.example', { isMainFrame: false })).toBe(false)
  })

  it('answers undefined for a non-tab, refuses an unknown media type, a registered app and a non-website', () => {
    expect(rig({ isTab: false }).engine.check('camera', new FakeTab(), SITE, CHECK)).toBeUndefined()
    expect(rig().engine.check('camera', null, SITE, CHECK)).toBeUndefined()
    const { engine, store, tab } = rig({ apps: [SITE] })
    store.set(SITE, 'camera', 'allow')
    expect(engine.check('camera', tab, SITE, CHECK)).toBe(false)
    expect(engine.check('unknown', tab, SITE, CHECK)).toBe(false)
    expect(engine.check('camera', tab, 'chrome-extension://abc', CHECK)).toBe(false)
  })

  it('marks the page allowed when a main frame is given its stored allow', () => {
    const { engine, store, access, tab } = rig()
    store.set(SITE, 'camera', 'allow')
    engine.check('camera', tab, SITE, CHECK)
    expect(access.entries(tab)).toEqual([{ kind: 'camera', state: 'allowed' }])
  })
})
