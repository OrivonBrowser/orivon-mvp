import { describe, expect, it, vi } from 'vitest'
import { createExtensionMedia, type ExtensionMediaDeps, type MediaChoice } from '../extension-media.js'
import type { ExtensionMediaAnswers } from '../extension-prefs.js'
import { createNagLimit } from '../permission-nag-limit.js'

const ID = 'a'.repeat(32)
const ORIGIN = `chrome-extension://${ID}`
const PAGE = { name: 'options page' }
const PLACE = { window: 'w', tabId: 't' }

type Place = typeof PLACE

interface Harness {
  engine: ReturnType<typeof createExtensionMedia<object, Place>>
  answers: Map<string, ExtensionMediaAnswers>
  ask: ReturnType<typeof vi.fn<(place: Place, id: string, kinds: readonly string[]) => Promise<MediaChoice>>>
  saved: Array<[string, string, string]>
}

function harness (options: Partial<ExtensionMediaDeps<object, Place>> & { choice?: MediaChoice, stored?: ExtensionMediaAnswers } = {}): Harness {
  const answers = new Map<string, ExtensionMediaAnswers>()
  if (options.stored !== undefined) answers.set(ID, options.stored)
  const saved: Array<[string, string, string]> = []
  const ask = vi.fn(async (_place: Place, _id: string, _kinds: readonly string[]): Promise<MediaChoice> => options.choice ?? 'dismiss')
  const engine = createExtensionMedia<object, Place>({
    isLoaded: (id) => id === ID,
    answers: (id) => answers.get(id) ?? {},
    save: (id, kind, answer) => {
      saved.push([id, kind, answer])
      answers.set(id, { ...answers.get(id), [kind]: answer })
    },
    blockedByDefault: () => false,
    placeOf: () => PLACE,
    ask,
    nag: createNagLimit(),
    ...options
  })
  return { engine, answers, ask, saved }
}

const details = (extra: object = {}): object => ({ mediaTypes: ['video'], securityOrigin: ORIGIN, requestingUrl: `${ORIGIN}/options.html`, isMainFrame: true, ...extra })

describe('which requests the extension rules own', () => {
  it('leaves a page that is not an extension, an empty mediaTypes and an unknown type to the gate', () => {
    const { engine, ask } = harness()
    expect(engine.request(PAGE, 'media', details({ securityOrigin: 'https://a.example' }))).toBeUndefined()
    expect(engine.request(PAGE, 'media', details({ mediaTypes: [] }))).toBeUndefined()
    expect(engine.request(PAGE, 'media', details({ mediaTypes: ['video', 'tab'] }))).toBeUndefined()
    expect(engine.request(PAGE, 'media', details({ mediaTypes: undefined }))).toBeUndefined()
    expect(engine.request(PAGE, 'geolocation', details())).toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
  })

  it('leaves the origin of an extension that is not loaded to the gate', () => {
    const { engine } = harness({ isLoaded: () => false })
    expect(engine.request(PAGE, 'media', details())).toBeUndefined()
  })

  it('refuses a frame that is not the main frame, and a request whose url is another origin, without asking', async () => {
    const { engine, ask } = harness({ stored: { camera: 'allow' } })
    expect(await engine.request(PAGE, 'media', details({ isMainFrame: false }))).toBe(false)
    expect(await engine.request(PAGE, 'media', details({ isMainFrame: undefined }))).toBe(false)
    expect(await engine.request(PAGE, 'media', details({ requestingUrl: 'https://evil.example/' }))).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('a stored answer', () => {
  it('allows a stored allow for every kind asked, without asking', async () => {
    const { engine, ask } = harness({ stored: { camera: 'allow', microphone: 'allow' } })
    expect(await engine.request(PAGE, 'media', details({ mediaTypes: ['video', 'audio'] }))).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses a stored block, and one blocked kind refuses a request for both', async () => {
    const { engine, ask } = harness({ stored: { camera: 'allow', microphone: 'block' } })
    expect(await engine.request(PAGE, 'media', details({ mediaTypes: ['audio'] }))).toBe(false)
    expect(await engine.request(PAGE, 'media', details({ mediaTypes: ['video', 'audio'] }))).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses an undecided kind when its Settings default is block, but a stored allow still wins', async () => {
    const blockedByDefault = (kind: string): boolean => kind === 'camera'
    const none = harness({ blockedByDefault })
    expect(await none.engine.request(PAGE, 'media', details())).toBe(false)
    expect(none.ask).not.toHaveBeenCalled()
    const allowed = harness({ blockedByDefault, stored: { camera: 'allow' } })
    expect(await allowed.engine.request(PAGE, 'media', details())).toBe(true)
  })
})

describe('asking the person', () => {
  it('asks once for the undecided kinds, names the extension and stores an allow', async () => {
    const { engine, ask, saved } = harness({ choice: 'allow', stored: { microphone: 'allow' } })
    expect(await engine.request(PAGE, 'media', details({ mediaTypes: ['video', 'audio'] }))).toBe(true)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith(PLACE, ID, ['camera'])
    expect(saved).toEqual([[ID, 'camera', 'allow']])
  })

  it('asks for both kinds together and stores both', async () => {
    const { engine, ask, saved } = harness({ choice: 'allow' })
    expect(await engine.request(PAGE, 'media', details({ mediaTypes: ['video', 'audio'] }))).toBe(true)
    expect(ask).toHaveBeenCalledWith(PLACE, ID, ['camera', 'microphone'])
    expect(saved).toEqual([[ID, 'camera', 'allow'], [ID, 'microphone', 'allow']])
  })

  it('stores a block and refuses, and does not ask again', async () => {
    const { engine, ask, saved } = harness({ choice: 'block' })
    expect(await engine.request(PAGE, 'media', details())).toBe(false)
    expect(saved).toEqual([[ID, 'camera', 'block']])
    expect(await engine.request(PAGE, 'media', details())).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
  })

  it('stores nothing when the question is dismissed, refuses this request and asks the next', async () => {
    const { engine, ask, saved } = harness({ choice: 'dismiss' })
    expect(await engine.request(PAGE, 'media', details())).toBe(false)
    expect(saved).toEqual([])
    await engine.request(PAGE, 'media', details())
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('stops asking after three dismissals in a minute', async () => {
    const { engine, ask } = harness({ choice: 'dismiss' })
    for (let i = 0; i < 5; i++) expect(await engine.request(PAGE, 'media', details())).toBe(false)
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('shares one question between two requests for the same kinds that arrive while it is open', async () => {
    let answer: (choice: MediaChoice) => void = () => {}
    const { engine, ask } = harness({})
    ask.mockImplementation(async () => await new Promise<MediaChoice>((resolve) => { answer = resolve }))
    const first = engine.request(PAGE, 'media', details())
    const second = engine.request(PAGE, 'media', details())
    expect(ask).toHaveBeenCalledOnce()
    answer('allow')
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })

  it('refuses a page with no visible place without asking, and still honours a stored answer', async () => {
    const none = harness({ placeOf: () => undefined, choice: 'allow' })
    expect(await none.engine.request(PAGE, 'media', details())).toBe(false)
    expect(none.ask).not.toHaveBeenCalled()
    expect(none.saved).toEqual([])
    const stored = harness({ placeOf: () => undefined, stored: { camera: 'allow' } })
    expect(await stored.engine.request(PAGE, 'media', details())).toBe(true)
  })

  it('stores nothing and refuses when the extension went away while the question was open', async () => {
    let loaded = true
    const { engine, saved } = harness({ choice: 'allow', isLoaded: () => loaded })
    const pending = engine.request(PAGE, 'media', details())
    loaded = false
    expect(await pending).toBe(false)
    expect(saved).toEqual([])
  })

  it('refuses when the question itself fails', async () => {
    const { engine, ask, saved } = harness({})
    ask.mockRejectedValue(new Error('no sheet'))
    expect(await engine.request(PAGE, 'media', details())).toBe(false)
    expect(saved).toEqual([])
  })
})

describe('the check handler', () => {
  const check = (engine: Harness['engine'], extra: object = {}, origin = `${ORIGIN}/`): boolean | undefined =>
    engine.check(PAGE, 'media', origin, { mediaType: 'video', securityOrigin: ORIGIN, isMainFrame: true, ...extra })

  it('answers true for a kind stored as allow and false for anything else', () => {
    const { engine } = harness({ stored: { camera: 'allow', microphone: 'block' } })
    expect(check(engine)).toBe(true)
    expect(check(engine, { mediaType: 'audio' })).toBe(false)
    expect(check(engine, { mediaType: 'unknown' })).toBe(false)
    expect(check(harness().engine)).toBe(false)
  })

  it('never answers for a page that is not a loaded extension, or for another permission', () => {
    const { engine } = harness({ stored: { camera: 'allow' } })
    expect(check(engine, { securityOrigin: 'https://a.example' }, 'https://a.example/')).toBeUndefined()
    expect(check(harness({ isLoaded: () => false }).engine)).toBeUndefined()
    expect(engine.check(PAGE, 'geolocation', `${ORIGIN}/`, { securityOrigin: ORIGIN, isMainFrame: true })).toBeUndefined()
  })

  it('refuses a frame inside another page, and a frame whose origin is not the one asked about', () => {
    const { engine } = harness({ stored: { camera: 'allow' } })
    expect(check(engine, { isMainFrame: false })).toBe(false)
    expect(check(engine, { embeddingOrigin: 'https://a.example' })).toBe(false)
    expect(check(engine, { embeddingOrigin: `chrome-extension://${'b'.repeat(32)}/` })).toBe(false)
    expect(check(engine, { securityOrigin: `chrome-extension://${'b'.repeat(32)}` })).toBeUndefined()
  })

  it('reads the shape Electron sends for an extension page: its own origin as the embedder, and no security origin', () => {
    const { engine } = harness({ stored: { camera: 'allow' } })
    const measured = { embeddingOrigin: `${ORIGIN}/`, isMainFrame: true, mediaType: 'video', requestingUrl: `${ORIGIN}/page.html` }
    expect(engine.check(PAGE, 'media', `${ORIGIN}/`, measured)).toBe(true)
    expect(engine.check(PAGE, 'media', `${ORIGIN}/`, { ...measured, mediaType: 'audio' })).toBe(false)
    const { mediaType: _type, ...untyped } = measured
    expect(engine.check(PAGE, 'media', `${ORIGIN}/`, untyped)).toBe(false)
  })

  it('answers from the stored allow with no contents at all', () => {
    const { engine } = harness({ stored: { camera: 'allow' } })
    expect(engine.check(null, 'media', `${ORIGIN}/`, { mediaType: 'video', securityOrigin: ORIGIN, isMainFrame: true })).toBe(true)
  })
})
