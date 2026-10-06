// Electron's `desktopCapturer` on top of the page's own `getDisplayMedia`, so Orivon's picker is what chooses what is
// shared (ADR-0055). `getSources` runs the picker and resolves the one thing the person chose, as a source whose id
// the app then hands back through the legacy `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop',
// chromeMediaSourceId } } })` call, in its promise form or in the callback forms `navigator.webkitGetUserMedia` and
// `navigator.getUserMedia`; the wrappers below answer that call from the stream the picker produced and refuse
// every other desktop capture, which would reach the display with no picker. Pure over `DesktopCapturerEnv`,
// so every branch is unit-tested with fakes.

export interface DesktopCapturerSource {
  readonly id: string
  readonly name: string
  readonly display_id: string
  readonly appIcon: null
  readonly thumbnail: ShimNativeImage
}

/** The part of Electron's `NativeImage` a screen-share app reads a thumbnail with. */
export interface ShimNativeImage {
  toDataURL: () => string
  toPNG: () => Uint8Array
  toJPEG: (quality: number) => Uint8Array
  isEmpty: () => boolean
  getSize: () => { width: number, height: number }
}

export interface SourcesOptions {
  readonly types?: readonly string[]
  readonly thumbnailSize?: { readonly width: number, readonly height: number }
  readonly fetchWindowIcons?: boolean
}

export interface ElectronDesktopCapturer {
  getSources: (options?: SourcesOptions) => Promise<DesktopCapturerSource[]>
}

/** The callback forms of `getUserMedia` an old app calls on `navigator`; each one present is wrapped. */
export interface LegacyNavigator {
  webkitGetUserMedia?: LegacyGetUserMedia
  getUserMedia?: LegacyGetUserMedia
}
type LegacyGetUserMedia = (constraints: MediaStreamConstraints, success?: (stream: MediaStream) => void, failure?: (error: unknown) => void) => void

export interface DesktopCapturerEnv {
  readonly mediaDevices: MediaDevices | undefined
  readonly navigator?: LegacyNavigator | undefined
  readonly document: Pick<Document, 'createElement'>
  readonly random: () => string
}

/** How long a stream the picker produced waits for the app to ask for it before it is stopped. */
export const UNUSED_STREAM_MS = 60_000
export const ID_PREFIX = 'orivon-shared:'
const DEFAULT_THUMBNAIL = { width: 150, height: 150 }
const FRAME_WAIT_MS = 2000

interface Held {
  stream: MediaStream
  timer: ReturnType<typeof setTimeout>
}

/** One wrapper per `mediaDevices`, however many capturers are built over it. */
const held = new WeakMap<object, Map<string, Held>>()

const notAllowed = (message: string): DOMException => new DOMException(message, 'NotAllowedError')

type Loose = Record<string, unknown>
const asRecord = (value: unknown): Loose | undefined => typeof value === 'object' && value !== null ? value as Loose : undefined

/** Where a legacy constraint names its source: on the track constraints, or under `mandatory`. */
function legacySource (track: unknown): { source?: unknown, id?: unknown } | undefined {
  const outer = asRecord(track)
  if (outer === undefined) return undefined
  const inner = asRecord(outer.mandatory)
  const source = outer.chromeMediaSource ?? inner?.chromeMediaSource
  if (source === undefined) return undefined
  return { source, id: outer.chromeMediaSourceId ?? inner?.chromeMediaSourceId }
}

/** One held map per `mediaDevices`, or per `navigator` when the page has no devices; every form of the call shares it. */
function holdingFor (env: Pick<DesktopCapturerEnv, 'mediaDevices' | 'navigator'>): Map<string, Held> | undefined {
  const owner: object | undefined = env.mediaDevices ?? env.navigator
  if (owner === undefined) return undefined
  let map = held.get(owner)
  if (map === undefined) {
    map = new Map()
    held.set(owner, map)
    if (env.mediaDevices !== undefined) wrapGetUserMedia(env.mediaDevices, map)
    if (env.navigator !== undefined) for (const name of ['webkitGetUserMedia', 'getUserMedia'] as const) wrapLegacy(env.navigator, name, map)
  }
  return map
}

function release (map: Map<string, Held>, id: string, stop: boolean): MediaStream | undefined {
  const found = map.get(id)
  if (found === undefined) return undefined
  clearTimeout(found.timer)
  map.delete(id)
  if (stop) for (const track of found.stream.getTracks()) track.stop()
  return found.stream
}

/** What a `getUserMedia` call for these constraints gets: a held stream, a refusal, or nothing said (every other call). */
function answerFor (map: Map<string, Held>, constraints: MediaStreamConstraints | undefined): MediaStream | DOMException | undefined {
  const video = legacySource(constraints?.video)
  const audio = legacySource(constraints?.audio)
  if (video === undefined && audio === undefined) return undefined
  // Only a held id is served; the audio half of that call is dropped, which the README says.
  if (video?.source === 'desktop' && typeof video.id === 'string' && (audio === undefined || audio.source === 'desktop')) {
    const stream = release(map, video.id, false)
    if (stream !== undefined) return stream
  }
  return notAllowed('Orivon shares a screen only through its own picker: call desktopCapturer.getSources first, and pass the id it returned once.')
}

function wrapGetUserMedia (devices: MediaDevices, map: Map<string, Held>): void {
  const original = devices.getUserMedia.bind(devices)
  devices.getUserMedia = async function getUserMedia (constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const answer = answerFor(map, constraints)
    if (answer === undefined) return await original(constraints)
    if (answer instanceof DOMException) throw answer
    return answer
  }
}

/** The callback form: served or refused through its callbacks, a turn later as the browser's own would be. */
function wrapLegacy (navigator: LegacyNavigator, name: 'webkitGetUserMedia' | 'getUserMedia', map: Map<string, Held>): void {
  const original = navigator[name]
  if (typeof original !== 'function') return
  navigator[name] = function getUserMedia (constraints, success, failure) {
    const answer = answerFor(map, constraints)
    if (answer === undefined) { original.call(navigator, constraints, success, failure); return }
    queueMicrotask(() => {
      if (answer instanceof DOMException) failure?.(answer)
      else success?.(answer)
    })
  }
}

/** Real Electron scales the thumbnail to fit the size asked for, keeping the aspect ratio. */
function fitted (frame: { width: number, height: number }, box: { width: number, height: number }): { width: number, height: number } {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(box.width / frame.width, box.height / frame.height)
  return { width: Math.max(1, Math.round(frame.width * scale)), height: Math.max(1, Math.round(frame.height * scale)) }
}

function bytesOfDataUrl (url: string): Uint8Array {
  const comma = url.indexOf(',')
  if (comma < 0) return new Uint8Array()
  const binary = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const EMPTY_IMAGE: ShimNativeImage = {
  toDataURL: () => '',
  toPNG: () => new Uint8Array(),
  toJPEG: () => new Uint8Array(),
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 })
}

function imageOf (canvas: HTMLCanvasElement): ShimNativeImage {
  return {
    toDataURL: () => canvas.toDataURL('image/png'),
    toPNG: () => bytesOfDataUrl(canvas.toDataURL('image/png')),
    toJPEG: (quality) => bytesOfDataUrl(canvas.toDataURL('image/jpeg', Math.min(1, Math.max(0, quality / 100)))),
    isEmpty: () => false,
    getSize: () => ({ width: canvas.width, height: canvas.height })
  }
}

/** One frame of the stream at the size asked for, or an empty image when there is none to be had. */
async function thumbnailOf (env: DesktopCapturerEnv, stream: MediaStream, size: { width: number, height: number }): Promise<ShimNativeImage> {
  if (size.width <= 0 || size.height <= 0) return EMPTY_IMAGE
  const video = env.document.createElement('video')
  try {
    video.muted = true
    video.srcObject = stream
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FRAME_WAIT_MS)
      const ready = (): void => { clearTimeout(timer); resolve() }
      if (video.readyState >= 2) return ready()
      video.addEventListener('loadeddata', ready, { once: true })
      video.play().catch(() => {})
    })
    const target = fitted({ width: video.videoWidth, height: video.videoHeight }, size)
    if (target.width === 0) return EMPTY_IMAGE
    const canvas = env.document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (context === null) return EMPTY_IMAGE
    context.drawImage(video, 0, 0, target.width, target.height)
    return imageOf(canvas)
  } catch {
    return EMPTY_IMAGE
  } finally {
    video.pause()
    video.srcObject = null
  }
}

/** The hint the types give the picker: only windows or only screens opens it on that surface. */
function surfaceHint (types: readonly string[] | undefined): 'window' | 'monitor' | undefined {
  if (types === undefined || types.length === 0) return undefined
  if (types.every((type) => type === 'window')) return 'window'
  if (types.every((type) => type === 'screen')) return 'monitor'
  return undefined
}

export function createDesktopCapturer (env: DesktopCapturerEnv): ElectronDesktopCapturer {
  // Wrapped now, so a refused desktop capture is refused even before the first `getSources`.
  holdingFor(env)

  return {
    async getSources (options) {
      const devices = env.mediaDevices
      const map = holdingFor(env)
      if (devices === undefined || map === undefined) throw new TypeError('desktopCapturer.getSources needs navigator.mediaDevices, which this page does not have (a secure context is required).')
      const hint = surfaceHint(options?.types)
      let stream: MediaStream
      try {
        stream = await devices.getDisplayMedia({ video: hint === undefined ? true : { displaySurface: hint }, audio: false })
      } catch (error) {
        // The person closed the picker, or sharing is blocked here: no source, as a closed system dialog gives.
        if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return []
        throw error
      }
      const id = `${ID_PREFIX}${env.random()}`
      const timer = setTimeout(() => { release(map, id, true) }, UNUSED_STREAM_MS)
      map.set(id, { stream, timer })
      const size = options?.thumbnailSize ?? DEFAULT_THUMBNAIL
      const thumbnail = await thumbnailOf(env, stream, size)
      const name = stream.getVideoTracks()[0]?.label ?? ''
      return [{ id, name, display_id: '', appIcon: null, thumbnail }]
    }
  }
}
