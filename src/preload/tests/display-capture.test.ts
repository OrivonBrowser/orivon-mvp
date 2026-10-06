import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  executeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: bridge.executeInMainWorld },
  ipcRenderer: { invoke: bridge.invoke, send: bridge.send, on: bridge.on }
}))

const { DISPLAY_CAPTURE_CHANNEL, DISPLAY_CAPTURE_PICK_CHANNEL, DISPLAY_CAPTURE_STOP_CHANNEL } = await import('../../main/channels.js')

type Outcome = { ok: true, holder: unknown } | { ok: false, name: string, message: string }
type Result = { ok: boolean, share?: string, name?: string, message?: string }
type CallNow = (onSettled: (outcome: Outcome) => Result) => void
type Share = (options: object, callNow: CallNow) => Promise<Result>
const install = async (): Promise<{ share: Share, cloneEvent: string }> => {
  const { installDisplayCapture } = await import('../display-capture.js')
  installDisplayCapture()
  const call = bridge.executeInMainWorld.mock.calls.at(-1)?.[0] as { args: [Share, string] }
  return { share: call.args[0], cloneEvent: call.args[1] }
}

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  stop (): void { this.readyState = 'ended' }
  end (): void { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
}

const OPTIONS = { audio: false, hints: { displaySurface: 'monitor' } }

class FakeStream {
  constructor (readonly tracks: FakeTrack[] = []) {}
  getTracks (): FakeTrack[] { return this.tracks }
}
const stream = (tracks: FakeTrack[]): FakeStream => new FakeStream(tracks)

/** A `callNow` whose real call is `outcome`: it settles in a microtask, as the main world's native promise does. */
function callNowOf (outcome: () => Outcome, events: string[] = []): CallNow & { calls: number } {
  const callNow = Object.assign((onSettled: (value: Outcome) => Result): void => {
    callNow.calls++
    events.push('callNow')
    void Promise.resolve().then(() => { onSettled(outcome()) })
  }, { calls: 0 })
  return callNow
}
const succeeds = (tracks: FakeTrack[], events: string[] = []): CallNow & { calls: number } => callNowOf(() => ({ ok: true, holder: { srcObject: stream(tracks) } }), events)
const fails = (name: string, message = 'no'): CallNow & { calls: number } => callNowOf(() => ({ ok: false, name, message }))

function stubPage (extras: { allowed?: boolean, active?: boolean } = {}): void {
  vi.stubGlobal('window', { isSecureContext: true, addEventListener: vi.fn() })
  vi.stubGlobal('document', { permissionsPolicy: { allowsFeature: () => extras.allowed ?? true } })
  vi.stubGlobal('navigator', { userActivation: { isActive: extras.active ?? true } })
  vi.stubGlobal('HTMLVideoElement', class {})
  vi.stubGlobal('MediaStream', FakeStream)
}

beforeEach(() => {
  vi.resetModules()
  for (const mock of Object.values(bridge)) mock.mockReset()
  vi.stubGlobal('crypto', { getRandomValues: (words: Uint32Array) => words.fill(7) })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the screen-share wrapper installer', () => {
  it('wraps in the page\'s world, listens for Stop and for clones, and logs rather than throws when it cannot', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    const { installDisplayCapture } = await import('../display-capture.js')
    installDisplayCapture()
    expect(bridge.executeInMainWorld).toHaveBeenCalledOnce()
    expect(bridge.on).toHaveBeenCalledWith(DISPLAY_CAPTURE_STOP_CHANNEL, expect.any(Function))

    bridge.executeInMainWorld.mockImplementation(() => { throw new Error('unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { installDisplayCapture() }).not.toThrow()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('the wrapper in the page\'s world', () => {
  it('does nothing, and does not throw, in a document with no MediaDevices (an error page, a blank page)', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    const { share, cloneEvent } = await install()
    const wrap = (bridge.executeInMainWorld.mock.calls.at(-1)?.[0] as { func: (share: Share, cloneEvent: string) => void }).func
    vi.stubGlobal('MediaDevices', undefined)
    expect(() => { wrap(share, cloneEvent) }).not.toThrow()
  })
})

describe('the real call the wrapper makes in the page\'s world', () => {
  class FakeDevices { getDisplayMedia (_options?: unknown): Promise<unknown> { return Promise.resolve(undefined) } }
  class FakeTrackType { clone (): unknown { return this } stop (this: { readyState: string }): void { this.readyState = 'ended' } }
  class FakeStreamType extends FakeStream { clone (): unknown { return this } }
  class FakeMedia {
    held: unknown
    get srcObject (): unknown { return this.held ?? null }
    set srcObject (value: unknown) { if (!(value instanceof FakeStreamType)) throw new TypeError('not a stream'); this.held = value }
  }
  class FakeDocument { createElement (_tag: string): object { return Object.create(FakeMedia.prototype) as object } }

  /** Installs the wrapper over fakes; `native` is the browser's own `getDisplayMedia`, and `isolated` is what the other world does. */
  async function wrapped (native: (this: unknown, options: unknown) => Promise<unknown>, isolated: Share): Promise<FakeDevices> {
    FakeDevices.prototype.getDisplayMedia = native
    vi.stubGlobal('MediaDevices', FakeDevices)
    vi.stubGlobal('MediaStreamTrack', FakeTrackType)
    vi.stubGlobal('MediaStream', FakeStreamType)
    vi.stubGlobal('Document', FakeDocument)
    vi.stubGlobal('HTMLMediaElement', FakeMedia)
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    vi.stubGlobal('document', new FakeDocument())
    const devices = new FakeDevices()
    vi.stubGlobal('navigator', { mediaDevices: devices })
    const { cloneEvent } = await install()
    const wrap = (bridge.executeInMainWorld.mock.calls.at(-1)?.[0] as { func: (share: Share, cloneEvent: string) => void }).func
    wrap(isolated, cloneEvent)
    return devices
  }
  /** The other world as it behaves once the person picked: it runs the call, and answers its outcome as a share. */
  const answer = (outcome: Outcome): Result => outcome.ok ? { ok: true, share: 'share-id' } : { ok: false, name: outcome.name, message: outcome.message }
  const pickedShare = (order: string[] = []): Share => (_options, callNow) => new Promise((resolve) => {
    order.push('armed')
    callNow((outcome) => { const result = answer(outcome); resolve(result); return result })
  })

  it('makes the real call once, on the page\'s MediaDevices, with options that have no prototype and carry the page\'s controller', async () => {
    const stream = new FakeStreamType([])
    const seen: Array<{ self: unknown, options: Record<string, unknown> }> = []
    const order: string[] = []
    const controller = { brand: 'controller' }
    const devices = await wrapped(function (this: unknown, options) { order.push('native'); seen.push({ self: this, options: options as Record<string, unknown> }); return Promise.resolve(stream) }, pickedShare(order))
    const result = await devices.getDisplayMedia({ video: { displaySurface: 'monitor', width: { ideal: 640 }, advanced: [{ frameRate: 5 }] }, audio: false, controller })
    expect(result).toBe(stream)
    expect(order).toEqual(['armed', 'native'])
    expect(seen).toHaveLength(1)
    expect(seen[0]?.self).toBe(devices)
    const options = seen[0]?.options as { video: { width: { ideal: number }, advanced: unknown[] }, audio: unknown, controller: unknown }
    expect(Object.getPrototypeOf(options)).toBeNull()
    expect(Object.getPrototypeOf(options.video)).toBeNull()
    expect(Object.getPrototypeOf(options.video.width)).toBeNull()
    expect(options.video.width.ideal).toBe(640)
    expect(options.audio).toBe(false)
    expect(options.controller).toBe(controller)
    expect(Object.keys(options).sort()).toEqual(['audio', 'controller', 'video'])
    // A sequence still reads as one, through an iterator of its own that no page change reaches.
    const real = Object.getOwnPropertyDescriptor(options.video.advanced, Symbol.iterator)
    expect(real).toBeDefined()
    const saved = Array.prototype[Symbol.iterator]
    Array.prototype[Symbol.iterator] = (): never => { throw new Error('page code ran') }
    let spread: unknown[]
    try { spread = [...(options.video.advanced as Iterable<unknown>)] } finally { Array.prototype[Symbol.iterator] = saved }
    expect(spread).toEqual([{ frameRate: 5 }])
  })

  it('passes no controller when the page gave none, and never runs a getter of the page\'s options during the call', async () => {
    const seen: Array<Record<string, unknown>> = []
    let reads = 0
    const devices = await wrapped(function (_options) { seen.push(_options as Record<string, unknown>); return Promise.resolve(new FakeStreamType([])) }, pickedShare())
    const video = { get displaySurface () { reads++; return 'monitor' } }
    await devices.getDisplayMedia({ video })
    const readsAtCall = reads
    expect(Object.keys(seen[0] as object).sort()).toEqual(['audio', 'video'])
    expect(readsAtCall).toBeGreaterThan(0)
    const options = seen[0] as { video: Record<string, unknown> }
    expect(Object.getOwnPropertyDescriptor(options.video, 'displaySurface')).toMatchObject({ value: 'monitor' })
    expect(reads).toBe(readsAtCall)
  })

  it('makes the real call only on the page\'s own MediaDevices: another one, or a page that changed MediaDevices or Symbol, gets the browser\'s own call', async () => {
    const seen: unknown[] = []
    const isolated = vi.fn(pickedShare())
    const devices = await wrapped(function (this: unknown, options) { seen.push(this); return Promise.resolve(new FakeStreamType([])) }, isolated)
    const other = new FakeDevices()
    vi.stubGlobal('MediaDevices', function Impostor () {})
    await (devices.getDisplayMedia as (this: unknown, options: unknown) => Promise<unknown>).call(other, { video: true })
    expect(isolated).not.toHaveBeenCalled()
    expect(seen).toEqual([other])
    const calls: Array<{ video: { advanced: object } }> = []
    const own = await wrapped(function (options) { calls.push(options as { video: { advanced: object } }); return Promise.resolve(new FakeStreamType([])) }, pickedShare())
    const savedSymbol = globalThis.Symbol
    globalThis.Symbol = new Proxy(savedSymbol, { get: (target, key) => key === 'iterator' ? 'page-key' : key === 'species' ? 'page-species' : Reflect.get(target, key) as unknown })
    let pending: Promise<unknown>
    try { pending = own.getDisplayMedia({ video: { advanced: [{ frameRate: 5 }] } }) } finally { globalThis.Symbol = savedSymbol }
    await pending
    expect(Object.getOwnPropertyDescriptor(calls[0]?.video.advanced, savedSymbol.iterator)).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(calls[0]?.video.advanced, 'page-key')).toBeUndefined()
  })

  it('copies the options with the JSON it captured: a page that replaces JSON afterwards cannot put its own code in the call', async () => {
    const seen: Array<Record<string, unknown>> = []
    const devices = await wrapped(function (options) { seen.push(options as Record<string, unknown>); return Promise.resolve(new FakeStreamType([])) }, pickedShare())
    const saved = { parse: JSON.parse, stringify: JSON.stringify }
    const pageParse = vi.fn(() => ({ width: () => 'page code' }))
    JSON.parse = pageParse
    JSON.stringify = vi.fn(() => '{}')
    try {
      await devices.getDisplayMedia({ video: { width: 640 } })
    } finally {
      JSON.parse = saved.parse
      JSON.stringify = saved.stringify
    }
    expect(pageParse).not.toHaveBeenCalled()
    expect(Object.getOwnPropertyDescriptor((seen[0] as { video: object }).video, 'width')).toMatchObject({ value: 640 })
  })

  it('gives the page a refusal with the name the browser gave, read from a DOMException and from a TypeError', async () => {
    const thrown: Array<() => unknown> = [
      () => Promise.reject(new DOMException('Permission denied by system', 'NotAllowedError')),
      () => Promise.reject(new TypeError('bad options')),
      () => { throw new TypeError('thrown at once') }
    ]
    const asked: unknown[] = []
    const devices = await wrapped(function () { return thrown.shift()?.() as Promise<unknown> }, (_options, callNow) => new Promise((resolve) => {
      callNow((outcome) => { asked.push(outcome); const result = answer(outcome); resolve(result); return result })
    }))
    const first = await devices.getDisplayMedia({ video: true }).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(DOMException)
    expect(first).toMatchObject({ name: 'NotAllowedError', message: 'Permission denied by system' })
    const second = await devices.getDisplayMedia({ video: true }).catch((error: unknown) => error)
    expect(second).toBeInstanceOf(TypeError)
    expect(second).toMatchObject({ message: 'bad options' })
    const third = await devices.getDisplayMedia({ video: true }).catch((error: unknown) => error)
    expect(third).toBeInstanceOf(TypeError)
    expect(asked).toEqual([
      { ok: false, name: 'NotAllowedError', message: 'Permission denied by system' },
      { ok: false, name: 'TypeError', message: 'bad options' },
      { ok: false, name: 'TypeError', message: 'thrown at once' }
    ])
  })

  it('reads the outcome through the natives it captured: a page that changes Promise and DOMException afterwards changes nothing', async () => {
    const devices = await wrapped(function () { return Promise.reject(new DOMException('no', 'NotAllowedError')) }, pickedShare())
    const savedThen = Promise.prototype.then
    const savedConstructor = Promise.prototype.constructor
    const forgedName = vi.spyOn(DOMException.prototype, 'name', 'get')
    let forged = 0
    let attaching = false
    let outcome: unknown
    // No promise of the test itself is used while the page's changes are in place.
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        Promise.prototype.then = function (this: Promise<unknown>, ...args: unknown[]): never { forged++; return Reflect.apply(savedThen, this, args) as never } as typeof Promise.prototype.then
        Promise.prototype.constructor = class Forged { static get [Symbol.species] (): unknown { return this }; constructor (executor: (a: () => void, b: () => void) => void) { if (!attaching) forged++; executor(() => {}, () => {}) } } as unknown as PromiseConstructor
        forgedName.mockReturnValue('Forged')
        const refused = devices.getDisplayMedia({ video: true })
        attaching = true
        Reflect.apply(savedThen, refused, [undefined, (error: unknown) => { outcome = error }])
        attaching = false
        setTimeout(() => {
          Promise.prototype.then = savedThen
          Promise.prototype.constructor = savedConstructor
          forgedName.mockRestore()
          resolve()
        }, 20)
      }, 0)
    })
    expect(forged).toBe(0)
    expect(outcome).toMatchObject({ message: 'no' })
    expect((outcome as { name: string }).name).toBe('NotAllowedError')
  })

  it('stops what it was given and refuses when the other world reports a failure after the call succeeded', async () => {
    const track = new FakeTrack()
    const devices = await wrapped(function () { return Promise.resolve(new FakeStreamType([track])) }, (_options, callNow) => new Promise((resolve) => {
      callNow(() => { const result = { ok: false, name: 'AbortError', message: 'Failed to start capture' }; resolve(result); return result })
    }))
    await expect(devices.getDisplayMedia({ video: true })).rejects.toMatchObject({ name: 'AbortError' })
    expect(track.readyState).toBe('ended')
  })

  it('settles the page\'s promise in the turn the real call settled, so a controller can still take its focus choice', async () => {
    let timerRan = false
    setTimeout(() => { timerRan = true }, 0)
    const devices = await wrapped(function () { return Promise.resolve(new FakeStreamType([])) }, pickedShare())
    await devices.getDisplayMedia({ video: true })
    expect(timerRan).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 5))
  })

  it('answers a call made twice by the other world with the first answer only', async () => {
    let natives = 0
    const devices = await wrapped(function () { natives++; return Promise.resolve(new FakeStreamType([])) }, (_options, callNow) => new Promise((resolve) => {
      callNow(() => { const result = { ok: true, share: 'x' }; resolve(result); return result })
      callNow(() => ({ ok: true, share: 'second' }))
    }))
    await devices.getDisplayMedia({ video: true })
    expect(natives).toBe(1)
  })
})

describe('the call this world has the main world make for the page', () => {
  it('asks main to pick, arms the ticket in the same step as the real call, and says the call was made after a turn of the event loop', async () => {
    vi.useFakeTimers()
    const track = new FakeTrack()
    const events: string[] = []
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    bridge.send.mockImplementation((_channel: string, message: { type: string }) => { events.push(message.type) })
    const callNow = succeeds([track], events)
    const { share } = await install()
    const result = await share(OPTIONS, callNow)
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.invoke).toHaveBeenCalledWith(DISPLAY_CAPTURE_PICK_CHANNEL, { type: 'pick', audio: false, hints: { displaySurface: 'monitor' }, activation: true })
    expect(events.slice(0, 2)).toEqual(['arm', 'callNow'])
    expect(events.indexOf('called')).toBeGreaterThan(events.indexOf('callNow'))
    expect(callNow.calls).toBe(1)
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce: 'nonce-1', rejectedEarly: false })
    expect(result).toEqual({ ok: true, share: expect.any(String) })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'received', nonce: 'nonce-1' })
    expect(bridge.send).not.toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, expect.objectContaining({ type: 'failed' }))
  })

  it('never lets the ticket\'s nonce reach the main world: the result names the share by another id', async () => {
    vi.useFakeTimers()
    let counter = 0
    vi.stubGlobal('crypto', { getRandomValues: (words: Uint32Array) => words.fill(++counter) })
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'secret-nonce' })
    const { share } = await install()
    const result = await share(OPTIONS, succeeds([new FakeTrack()]))
    await vi.advanceTimersByTimeAsync(10)
    expect(JSON.stringify(result)).not.toContain('secret-nonce')
    expect(result.share).not.toBe('secret-nonce')
    // The nonce still reaches main, which is where it is checked.
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'arm', nonce: 'secret-nonce' })
  })

  it.each([
    ['NotAllowedError', 'NotAllowedError'],
    ['NotReadableError', 'NotReadableError'],
    ['NotFoundError', 'NotFoundError'],
    ['AbortError', 'AbortError'],
    ['SecurityError', 'AbortError']
  ])('reports a call that was refused with %s as failed with %s, gives the page the real name, and never reports received', async (thrown, reported) => {
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share } = await install()
    expect(await share(OPTIONS, fails(thrown))).toEqual({ ok: false, name: thrown, message: 'no' })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce: 'nonce-1', name: reported })
    expect(bridge.send).not.toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, expect.objectContaining({ type: 'received' }))
    expect(bridge.send).not.toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, expect.objectContaining({ type: 'tracks-ended' }))
  })

  it('reports that its call failed before the turn ended, and gives the page the error', async () => {
    vi.useFakeTimers()
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share } = await install()
    const result = await share(OPTIONS, fails('TypeError', 'bad constraints'))
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce: 'nonce-1', rejectedEarly: true })
    expect(result).toEqual({ ok: false, name: 'TypeError', message: 'bad constraints' })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce: 'nonce-1', name: 'AbortError' })
  })

  it.each([
    ['holds no stream', { ok: true, holder: { srcObject: null } }],
    ['holds something that is not a MediaStream', { ok: true, holder: { srcObject: { getTracks: () => [] } } }],
    ['is not an element at all', { ok: true, holder: 'nothing' }],
    ['is not an outcome', 'nonsense']
  ])('treats a call whose holder %s as an AbortError failure and keeps no track', async (_name, outcome) => {
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share } = await install()
    expect(await share(OPTIONS, callNowOf(() => outcome as Outcome))).toEqual({ ok: false, name: 'AbortError', message: 'Failed to start capture' })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce: 'nonce-1', name: 'AbortError' })
    expect(bridge.send).not.toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, expect.objectContaining({ type: 'received' }))
  })

  it('treats a call that throws through the bridge as an AbortError failure', async () => {
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share } = await install()
    const broken: CallNow = () => { throw new Error('bridge') }
    expect(await share(OPTIONS, broken)).toMatchObject({ ok: false, name: 'AbortError' })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce: 'nonce-1', name: 'AbortError' })
  })

  it.each([
    ['refuses', { type: 'refused', reason: 'denied' }],
    ['answers nonsense', { type: 'go' }],
    ['answers nothing', undefined]
  ])('gives the page NotAllowedError, and makes no call, when main %s', async (_name, reply) => {
    stubPage()
    bridge.invoke.mockResolvedValue(reply)
    const callNow = succeeds([])
    const { share } = await install()
    expect(await share(OPTIONS, callNow)).toMatchObject({ ok: false, name: 'NotAllowedError' })
    expect(callNow.calls).toBe(0)
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('gives the page NotAllowedError, and makes no call, when the invoke fails', async () => {
    stubPage()
    bridge.invoke.mockRejectedValue(new Error('gone'))
    const callNow = succeeds([])
    const { share } = await install()
    expect(await share(OPTIONS, callNow)).toMatchObject({ ok: false, name: 'NotAllowedError' })
    expect(callNow.calls).toBe(0)
  })

  it('refuses without asking main, and without a call, when the permissions policy blocks display capture', async () => {
    stubPage({ allowed: false })
    const callNow = succeeds([])
    const { share } = await install()
    expect(await share(OPTIONS, callNow)).toMatchObject({ ok: false, name: 'NotAllowedError' })
    expect(bridge.invoke).not.toHaveBeenCalled()
    expect(callNow.calls).toBe(0)
  })

  it('tells main whether the page had a gesture', async () => {
    stubPage({ active: false })
    bridge.invoke.mockResolvedValue({ type: 'refused', reason: 'activation' })
    const { share } = await install()
    await share(OPTIONS, succeeds([]))
    expect(bridge.invoke).toHaveBeenCalledWith(DISPLAY_CAPTURE_PICK_CHANNEL, expect.objectContaining({ activation: false }))
  })
})

describe('the tracks this world handed out', () => {
  async function started (tracks: FakeTrack[]): Promise<{ stop: (nonce: string) => void }> {
    vi.useFakeTimers()
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    await install().then(async ({ share }) => await share(OPTIONS, succeeds(tracks)))
    await vi.advanceTimersByTimeAsync(10)
    bridge.send.mockClear()
    const stopListener = bridge.on.mock.calls.find((call) => call[0] === DISPLAY_CAPTURE_STOP_CHANNEL)?.[1] as (event: unknown, payload: unknown) => void
    return { stop: (nonce) => { stopListener({}, { nonce }) } }
  }

  it('reports tracks-ended once every track has ended, and not before', async () => {
    const [a, b] = [new FakeTrack(), new FakeTrack()] as [FakeTrack, FakeTrack]
    await started([a, b])
    a.end()
    expect(bridge.send).not.toHaveBeenCalled()
    b.end()
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-1' })
    a.dispatchEvent(new Event('ended'))
    expect(bridge.send).toHaveBeenCalledOnce()
  })

  it('notices a track the page stopped itself, which raises no event, by polling', async () => {
    const track = new FakeTrack()
    await started([track])
    track.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-1' })
  })

  it('stops every track on Stop, tells the page they ended, and reports it', async () => {
    const [a, b] = [new FakeTrack(), new FakeTrack()] as [FakeTrack, FakeTrack]
    const { stop } = await started([a, b])
    const heard = vi.fn()
    a.addEventListener('ended', heard)
    stop('nonce-1')
    expect([a.readyState, b.readyState]).toEqual(['ended', 'ended'])
    expect(heard).toHaveBeenCalledOnce()
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-1' })
  })

  it('ignores a Stop for a share it does not know, and one without a nonce', async () => {
    const track = new FakeTrack()
    const { stop } = await started([track])
    stop('other')
    ;(stop as unknown as (payload: unknown) => void)(undefined)
    expect(track.readyState).toBe('live')
  })

  it('keeps a clone the main world hands over under the share it names, and not under the nonce', async () => {
    const original = new FakeTrack()
    const clone = new FakeTrack()
    vi.useFakeTimers()
    let counter = 0
    vi.stubGlobal('crypto', { getRandomValues: (words: Uint32Array) => words.fill(++counter) })
    stubPage()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share, cloneEvent } = await install()
    const id = (await share(OPTIONS, succeeds([original]))).share
    await vi.advanceTimersByTimeAsync(10)
    bridge.send.mockClear()
    const onClone = (window.addEventListener as unknown as { mock: { calls: Array<[string, (event: Event) => void]> } }).mock.calls.find((call) => call[0] === cloneEvent)?.[1] as (event: Event) => void
    const Video = HTMLVideoElement as unknown as new () => object
    const carry = (name: string): Event => ({ target: Object.assign(new Video(), { getAttribute: () => name, srcObject: new FakeStream([clone]) }) }) as unknown as Event
    onClone(carry('nonce-1'))
    original.end()
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-1' })
    bridge.send.mockClear()

    const second = new FakeTrack()
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-2' })
    const secondId = (await share(OPTIONS, succeeds([second]))).share
    await vi.advanceTimersByTimeAsync(10)
    bridge.send.mockClear()
    onClone(carry(secondId ?? ''))
    second.end()
    expect(bridge.send).not.toHaveBeenCalled()
    clone.end()
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-2' })
    expect(id).not.toBe(secondId)
  })
})
