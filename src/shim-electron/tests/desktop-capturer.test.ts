import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopCapturer, ID_PREFIX, UNUSED_STREAM_MS } from '../desktop-capturer.js'

interface FakeTrack { label: string, stop: ReturnType<typeof vi.fn> }

function fakeStream (label = 'Entire screen'): MediaStream & { track: FakeTrack } {
  const track: FakeTrack = { label, stop: vi.fn() }
  return { getTracks: () => [track], getVideoTracks: () => [track], track } as unknown as MediaStream & { track: FakeTrack }
}

type Legacy = (constraints: MediaStreamConstraints, success?: (stream: MediaStream) => void, failure?: (error: unknown) => void) => void

interface Fakes {
  navigator: { webkitGetUserMedia: ReturnType<typeof vi.fn>, getUserMedia: ReturnType<typeof vi.fn> } & { [key: string]: unknown }
  devices: MediaDevices
  getDisplayMedia: ReturnType<typeof vi.fn>
  getUserMedia: ReturnType<typeof vi.fn>
  canvases: Array<{ width: number, height: number, toDataURL: ReturnType<typeof vi.fn>, drawn: unknown[][] }>
  videos: Array<{ srcObject: unknown, paused: boolean }>
}

/** A page's media devices and the two elements a thumbnail is drawn with; the frame is 1600x900 unless the test says otherwise. */
function fakes (display: () => Promise<MediaStream>, frame = { videoWidth: 1600, videoHeight: 900, readyState: 4 }): { f: Fakes, env: Parameters<typeof createDesktopCapturer>[0] } {
  const getDisplayMedia = vi.fn(display)
  const getUserMedia = vi.fn(async () => fakeStream('camera'))
  const devices = { getDisplayMedia, getUserMedia } as unknown as MediaDevices
  const navigator = { webkitGetUserMedia: vi.fn(), getUserMedia: vi.fn() }
  const canvases: Fakes['canvases'] = []
  const videos: Fakes['videos'] = []
  const document = {
    createElement: (tag: string) => {
      if (tag === 'video') {
        const video = { ...frame, srcObject: null as unknown, muted: false, paused: false, addEventListener: (_: string, run: () => void) => { run() }, play: async () => {}, pause () { video.paused = true } }
        videos.push(video)
        return video
      }
      const drawn: unknown[][] = []
      const canvas = {
        width: 0,
        height: 0,
        drawn,
        toDataURL: vi.fn((type?: string) => `data:${type ?? 'image/png'};base64,${btoa('bytes')}`),
        getContext: () => ({ drawImage: (...args: unknown[]) => { drawn.push(args) } })
      }
      canvases.push(canvas)
      return canvas
    }
  } as unknown as Document
  return {
    f: { navigator, devices, getDisplayMedia, getUserMedia, canvases, videos },
    env: { mediaDevices: devices, navigator: navigator as unknown as Parameters<typeof createDesktopCapturer>[0]['navigator'], document, random: (() => { let n = 0; return () => `id${++n}` })() }
  }
}

const desktop = (id: unknown, extra: object = {}): MediaStreamConstraints =>
  ({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id } }, ...extra }) as MediaStreamConstraints

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('desktopCapturer.getSources', () => {
  it('runs the page\'s getDisplayMedia once and resolves the one source it produced', async () => {
    const stream = fakeStream('Entire screen')
    const { f, env } = fakes(async () => stream)
    const sources = await createDesktopCapturer(env).getSources({ types: ['window', 'screen'] })
    expect(f.getDisplayMedia).toHaveBeenCalledTimes(1)
    expect(f.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false })
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ id: `${ID_PREFIX}id1`, name: 'Entire screen', display_id: '', appIcon: null })
  })

  it('opens the picker on windows when only windows are asked, and on screens when only screens are', async () => {
    const { f, env } = fakes(async () => fakeStream())
    const capturer = createDesktopCapturer(env)
    await capturer.getSources({ types: ['window'] })
    await capturer.getSources({ types: ['screen'] })
    await capturer.getSources({})
    await capturer.getSources()
    expect(f.getDisplayMedia.mock.calls.map((call) => (call[0] as { video: unknown }).video)).toEqual([
      { displaySurface: 'window' }, { displaySurface: 'monitor' }, true, true
    ])
  })

  it('resolves no source when the picker is cancelled or sharing is blocked, and rethrows anything else', async () => {
    for (const name of ['NotAllowedError', 'AbortError']) {
      const { env } = fakes(async () => { throw new DOMException('no', name) })
      expect(await createDesktopCapturer(env).getSources({ types: ['screen'] })).toEqual([])
    }
    const { env } = fakes(async () => { throw new TypeError('bad') })
    await expect(createDesktopCapturer(env).getSources({ types: ['screen'] })).rejects.toThrow(TypeError)
  })

  it('rejects, naming the cause, when the page has no media devices', async () => {
    const { env } = fakes(async () => fakeStream())
    await expect(createDesktopCapturer({ ...env, mediaDevices: undefined }).getSources()).rejects.toThrow(/mediaDevices/)
  })

  it('gives the source an id of its own each time', async () => {
    const { env } = fakes(async () => fakeStream())
    const capturer = createDesktopCapturer(env)
    const first = await capturer.getSources()
    const second = await capturer.getSources()
    expect(first[0]!.id).not.toBe(second[0]!.id)
  })
})

describe('the thumbnail', () => {
  it('is one frame scaled to fit the default 150x150, with the NativeImage reads', async () => {
    const { f, env } = fakes(async () => fakeStream())
    const [source] = await createDesktopCapturer(env).getSources()
    const image = source!.thumbnail
    expect(image.isEmpty()).toBe(false)
    expect(image.getSize()).toEqual({ width: 150, height: 84 })
    expect(f.canvases[0]!.drawn).toHaveLength(1)
    expect(image.toDataURL()).toBe(`data:image/png;base64,${btoa('bytes')}`)
    expect(new TextDecoder().decode(image.toPNG())).toBe('bytes')
    expect(new TextDecoder().decode(image.toJPEG(80))).toBe('bytes')
    expect(f.canvases[0]!.toDataURL).toHaveBeenLastCalledWith('image/jpeg', 0.8)
  })

  it('honours thumbnailSize and keeps the aspect ratio', async () => {
    const { env } = fakes(async () => fakeStream())
    const [source] = await createDesktopCapturer(env).getSources({ thumbnailSize: { width: 320, height: 320 } })
    expect(source!.thumbnail.getSize()).toEqual({ width: 320, height: 180 })
  })

  it('is empty at 0x0, and when no frame could be had', async () => {
    const { f, env } = fakes(async () => fakeStream())
    const [none] = await createDesktopCapturer(env).getSources({ thumbnailSize: { width: 0, height: 0 } })
    expect(none!.thumbnail.isEmpty()).toBe(true)
    expect(none!.thumbnail.getSize()).toEqual({ width: 0, height: 0 })
    expect(none!.thumbnail.toDataURL()).toBe('')
    expect(none!.thumbnail.toPNG()).toHaveLength(0)
    expect(f.videos).toHaveLength(0)

    const noFrame = fakes(async () => fakeStream(), { videoWidth: 0, videoHeight: 0, readyState: 4 })
    const [blank] = await createDesktopCapturer(noFrame.env).getSources()
    expect(blank!.thumbnail.isEmpty()).toBe(true)
  })

  it('lets the preview element go once the frame is drawn, without stopping the stream', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    await createDesktopCapturer(env).getSources()
    expect(f.videos[0]).toMatchObject({ srcObject: null, paused: true })
    expect(stream.track.stop).not.toHaveBeenCalled()
  })
})

describe('getUserMedia, wrapped once', () => {
  it('serves a held id the stream getSources produced, then forgets the id', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const original = f.getUserMedia
    const [source] = await createDesktopCapturer(env).getSources()
    expect(await f.devices.getUserMedia(desktop(source!.id))).toBe(stream)
    expect(original).not.toHaveBeenCalled()
    await expect(f.devices.getUserMedia(desktop(source!.id))).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('also reads the id when it sits on the video constraints and not under mandatory', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const [source] = await createDesktopCapturer(env).getSources()
    expect(await f.devices.getUserMedia({ video: { chromeMediaSource: 'desktop', chromeMediaSourceId: source!.id } } as unknown as MediaStreamConstraints)).toBe(stream)
  })

  it('drops the desktop audio the app asked for beside the video', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const [source] = await createDesktopCapturer(env).getSources()
    const got = await f.devices.getUserMedia(desktop(source!.id, { audio: { mandatory: { chromeMediaSource: 'desktop' } } }))
    expect(got).toBe(stream)
  })

  it.each([
    ['an id nothing is held for', desktop('screen:0:0')],
    ['no id', { video: { mandatory: { chromeMediaSource: 'desktop' } } }],
    ['a tab source', { video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'x' } } }],
    ['desktop audio alone', { audio: { mandatory: { chromeMediaSource: 'desktop' } } }],
    ['desktop video with another source for the audio', { video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: 'x' } }, audio: { mandatory: { chromeMediaSource: 'tab' } } }]
  ])('refuses %s with NotAllowedError and never reaches the browser', async (_name, constraints) => {
    const { f, env } = fakes(async () => fakeStream())
    const original = f.getUserMedia
    createDesktopCapturer(env)
    await expect(f.devices.getUserMedia(constraints as MediaStreamConstraints)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(original).not.toHaveBeenCalled()
  })

  it('keeps a held id when another id is refused', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const [source] = await createDesktopCapturer(env).getSources()
    await expect(f.devices.getUserMedia(desktop('screen:0:0'))).rejects.toBeDefined()
    expect(await f.devices.getUserMedia(desktop(source!.id))).toBe(stream)
  })

  it('passes every other call through untouched', async () => {
    const { f, env } = fakes(async () => fakeStream())
    const original = f.getUserMedia
    createDesktopCapturer(env)
    const constraints = { video: { width: 640 }, audio: true }
    await f.devices.getUserMedia(constraints)
    expect(original).toHaveBeenCalledWith(constraints)
    await f.devices.getUserMedia({ audio: true })
    expect(original).toHaveBeenCalledTimes(2)
  })

  it('wraps once however many capturers are built over the same devices', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const original = f.getUserMedia
    createDesktopCapturer(env)
    const [source] = await createDesktopCapturer(env).getSources()
    expect(await f.devices.getUserMedia(desktop(source!.id))).toBe(stream)
    await f.devices.getUserMedia({ audio: true })
    expect(original).toHaveBeenCalledTimes(1)
  })
})

describe('a stream nobody asked for', () => {
  it('is stopped after 60 seconds and its id forgotten', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const [source] = await createDesktopCapturer(env).getSources()
    vi.advanceTimersByTime(UNUSED_STREAM_MS - 1)
    expect(stream.track.stop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stream.track.stop).toHaveBeenCalledTimes(1)
    await expect(f.devices.getUserMedia(desktop(source!.id))).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('is not stopped once the app has taken it', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const [source] = await createDesktopCapturer(env).getSources()
    await f.devices.getUserMedia(desktop(source!.id))
    vi.advanceTimersByTime(UNUSED_STREAM_MS * 2)
    expect(stream.track.stop).not.toHaveBeenCalled()
  })
})

describe.each(['webkitGetUserMedia', 'getUserMedia'] as const)('the callback form, navigator.%s', (name) => {
  const call = (f: Fakes, constraints: unknown): { success: ReturnType<typeof vi.fn>, failure: ReturnType<typeof vi.fn> } => {
    const success = vi.fn()
    const failure = vi.fn()
    ;(f.navigator[name] as unknown as Legacy)(constraints as MediaStreamConstraints, success, failure)
    return { success, failure }
  }

  it('serves a held id the stream getSources produced to the success callback, once, and never reaches the browser', async () => {
    const stream = fakeStream()
    const { f, env } = fakes(async () => stream)
    const original = f.navigator[name]
    const [source] = await createDesktopCapturer(env).getSources()
    const served = call(f, desktop(source!.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(served.success).toHaveBeenCalledWith(stream)
    expect(served.failure).not.toHaveBeenCalled()
    const again = call(f, desktop(source!.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(again.success).not.toHaveBeenCalled()
    expect(again.failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotAllowedError' }))
    expect(original).not.toHaveBeenCalled()
  })

  it.each([
    ['an id nothing is held for', desktop('screen:0:0')],
    ['a tab source', { video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'x' } } }],
    ['desktop audio alone', { audio: { mandatory: { chromeMediaSource: 'desktop' } } }]
  ])('refuses %s through the error callback and never reaches the browser, even before the first getSources', async (_label, constraints) => {
    const { f, env } = fakes(async () => fakeStream())
    const original = f.navigator[name]
    createDesktopCapturer(env)
    const refused = call(f, constraints)
    await vi.advanceTimersByTimeAsync(0)
    expect(refused.failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'NotAllowedError' }))
    expect(original).not.toHaveBeenCalled()
  })

  it('refuses without a callback and throws nothing', () => {
    const { f, env } = fakes(async () => fakeStream())
    createDesktopCapturer(env)
    expect(() => { (f.navigator[name] as unknown as Legacy)(desktop('screen:0:0')) }).not.toThrow()
  })

  it('passes every other call through with its callbacks, and keeps `this`', () => {
    const { f, env } = fakes(async () => fakeStream())
    const original = f.navigator[name]
    createDesktopCapturer(env)
    const success = vi.fn()
    const failure = vi.fn()
    ;(f.navigator[name] as unknown as Legacy)({ audio: true }, success, failure)
    expect(original).toHaveBeenCalledWith({ audio: true }, success, failure)
    expect(original.mock.contexts[0]).toBe(f.navigator)
  })

  it('wraps once however many capturers are built over the same navigator', async () => {
    const { f, env } = fakes(async () => fakeStream())
    const original = f.navigator[name]
    createDesktopCapturer(env)
    createDesktopCapturer(env)
    ;(f.navigator[name] as unknown as Legacy)({ audio: true })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('leaves a navigator without the form alone', () => {
    const { f, env } = fakes(async () => fakeStream())
    delete f.navigator[name]
    expect(() => createDesktopCapturer(env)).not.toThrow()
    expect(f.navigator[name]).toBeUndefined()
  })
})
