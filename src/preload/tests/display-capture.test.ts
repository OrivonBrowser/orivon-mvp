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

type Share = (options: object) => Promise<{ ok: boolean, nonce?: string, name?: string, message?: string }>
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

const OPTIONS = { audio: false, video: true, audioConstraints: false, hints: { displaySurface: 'monitor' }, handOff: 'hand-off' }

function stubPage (getDisplayMedia: () => Promise<unknown>, extras: { allowed?: boolean, active?: boolean } = {}): { handed: Array<{ stream: unknown, nonce: string | null }> } {
  const handed: Array<{ stream: unknown, nonce: string | null }> = []
  const holder = { srcObject: undefined as unknown, attributes: new Map<string, string>(), setAttribute (k: string, v: string) { this.attributes.set(k, v) }, dispatchEvent () { handed.push({ stream: holder.srcObject, nonce: holder.attributes.get('data-orivon-share') ?? null }); return true }, remove () {} }
  vi.stubGlobal('window', { isSecureContext: true, addEventListener: vi.fn() })
  vi.stubGlobal('document', {
    documentElement: { append: vi.fn() },
    createElement: () => holder,
    permissionsPolicy: { allowsFeature: () => extras.allowed ?? true }
  })
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia }, userActivation: { isActive: extras.active ?? true } })
  vi.stubGlobal('HTMLVideoElement', class {})
  vi.stubGlobal('MediaStream', class {})
  return { handed }
}

const stream = (tracks: FakeTrack[]): object => ({ getTracks: () => tracks })

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

describe('the call this world makes for the page', () => {
  it('asks main to pick, arms the ticket in the same step as the real call, and says the call was made after a turn of the event loop', async () => {
    vi.useFakeTimers()
    const track = new FakeTrack()
    const events: string[] = []
    const { handed } = stubPage(() => { events.push('getDisplayMedia'); return Promise.resolve(stream([track])) })
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    bridge.send.mockImplementation((_channel: string, message: { type: string }) => { events.push(message.type) })
    const { share } = await install()
    const result = await share(OPTIONS)
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.invoke).toHaveBeenCalledWith(DISPLAY_CAPTURE_PICK_CHANNEL, { type: 'pick', audio: false, hints: { displaySurface: 'monitor' }, activation: true })
    expect(events.slice(0, 2)).toEqual(['arm', 'getDisplayMedia'])
    expect(events).toContain('called')
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce: 'nonce-1', rejectedEarly: false })
    expect(result).toEqual({ ok: true, nonce: 'nonce-1' })
    expect(handed).toHaveLength(1)
    expect(handed[0]?.nonce).toBe('nonce-1')
  })

  it('reports that its call failed before the turn ended, and gives the page the error', async () => {
    vi.useFakeTimers()
    stubPage(() => Promise.reject(Object.assign(new Error('bad constraints'), { name: 'TypeError' })))
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    const { share } = await install()
    const result = await share(OPTIONS)
    await vi.advanceTimersByTimeAsync(10)
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce: 'nonce-1', rejectedEarly: true })
    expect(result).toEqual({ ok: false, name: 'TypeError', message: 'bad constraints' })
    expect(bridge.send).toHaveBeenCalledWith(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: 'nonce-1' })
  })

  it.each([
    ['refuses', { type: 'refused', reason: 'denied' }],
    ['answers nonsense', { type: 'go' }],
    ['answers nothing', undefined]
  ])('gives the page NotAllowedError, and makes no call, when main %s', async (_name, reply) => {
    const getDisplayMedia = vi.fn()
    stubPage(getDisplayMedia)
    bridge.invoke.mockResolvedValue(reply)
    const { share } = await install()
    expect(await share(OPTIONS)).toMatchObject({ ok: false, name: 'NotAllowedError' })
    expect(getDisplayMedia).not.toHaveBeenCalled()
    expect(bridge.send).not.toHaveBeenCalled()
  })

  it('gives the page NotAllowedError when the invoke fails', async () => {
    stubPage(vi.fn())
    bridge.invoke.mockRejectedValue(new Error('gone'))
    const { share } = await install()
    expect(await share(OPTIONS)).toMatchObject({ ok: false, name: 'NotAllowedError' })
  })

  it('refuses without asking main when the permissions policy blocks display capture', async () => {
    stubPage(vi.fn(), { allowed: false })
    const { share } = await install()
    expect(await share(OPTIONS)).toMatchObject({ ok: false, name: 'NotAllowedError' })
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('tells main whether the page had a gesture', async () => {
    stubPage(() => Promise.resolve(stream([])), { active: false })
    bridge.invoke.mockResolvedValue({ type: 'refused', reason: 'activation' })
    const { share } = await install()
    await share(OPTIONS)
    expect(bridge.invoke).toHaveBeenCalledWith(DISPLAY_CAPTURE_PICK_CHANNEL, expect.objectContaining({ activation: false }))
  })
})

describe('the tracks this world handed out', () => {
  async function started (tracks: FakeTrack[]): Promise<{ stop: (nonce: string) => void }> {
    vi.useFakeTimers()
    stubPage(() => Promise.resolve(stream(tracks)))
    bridge.invoke.mockResolvedValue({ type: 'go', nonce: 'nonce-1' })
    await install().then(async ({ share }) => await share(OPTIONS))
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
})
