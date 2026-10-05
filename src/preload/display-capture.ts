// Screen sharing for a page in a tab (ADR-0055). The page's `getDisplayMedia` is wrapped in its own world: the
// wrapper only asks, and this world makes the real call after the person picked, so the permission gate can tell that
// call from every other `media` request. The wrapper is not a boundary: a call that goes around it meets no ticket in
// main and is refused there. The wrapper reads the options Electron never passes to main, and a stream handed back
// is kept here so that Stop reaches its tracks, clones included.
import { contextBridge, ipcRenderer } from 'electron'
import { DISPLAY_CAPTURE_CHANNEL, DISPLAY_CAPTURE_PICK_CHANNEL, DISPLAY_CAPTURE_STOP_CHANNEL } from '../main/channels.js'

/** What the main world asks of this one for a call: the page's options, already reduced to what can be copied. */
interface ShareOptions {
  readonly audio: boolean
  readonly video: unknown
  readonly audioConstraints: unknown
  readonly hints: Record<string, unknown>
  /** The event the main world listens for to receive the stream; named by the main world, fresh for each call. */
  readonly handOff: string
}

type ShareResult = { readonly ok: true, readonly nonce: string } | { readonly ok: false, readonly name: string, readonly message: string }

/** The tracks one share handed to the page, originals and clones: a share has ended when all of them have. */
interface ShareRecord {
  readonly nonce: string
  readonly tracks: Set<MediaStreamTrack>
}

const POLL_MS = 1000
const records = new Map<string, ShareRecord>()
let poll: ReturnType<typeof setInterval> | undefined

const refusal = (name: string, message: string): ShareResult => ({ ok: false, name, message })

function ended (record: ShareRecord): boolean {
  for (const track of record.tracks) if (track.readyState !== 'ended') return false
  return true
}

/** Tells main once that every track of a share has ended: by the page, by the source, or by Stop. */
function settle (record: ShareRecord): void {
  if (!records.has(record.nonce) || !ended(record)) return
  records.delete(record.nonce)
  if (records.size === 0 && poll !== undefined) { clearInterval(poll); poll = undefined }
  ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce: record.nonce })
}

function keep (record: ShareRecord, track: MediaStreamTrack): void {
  if (record.tracks.has(track)) return
  record.tracks.add(track)
  track.addEventListener('ended', () => { settle(record) })
  // A page's own `stop()` raises no event: the state is read.
  poll ??= setInterval(() => { for (const each of [...records.values()]) settle(each) }, POLL_MS)
}

/** Whether the document's permissions policy lets this frame capture the display; true when the browser does not say. */
function policyAllows (): boolean {
  const policy = (document as unknown as { permissionsPolicy?: { allowsFeature?: (name: string) => boolean }, featurePolicy?: { allowsFeature?: (name: string) => boolean } })
  const source = policy.permissionsPolicy ?? policy.featurePolicy
  return typeof source?.allowsFeature !== 'function' || source.allowsFeature('display-capture')
}

function errorOf (error: unknown): ShareResult {
  const name = typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string' ? (error as { name: string }).name : 'AbortError'
  const message = typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : 'Failed to start capture'
  return refusal(name, message)
}

/** Hands the stream to the main world through the DOM: an element carries it, and an event the main world named announces it. */
function handOver (stream: MediaStream, event: string, nonce: string): boolean {
  const root = document.documentElement
  if (root === null) return false
  const holder = document.createElement('video')
  holder.srcObject = stream
  holder.setAttribute('data-orivon-share', nonce)
  root.append(holder)
  holder.dispatchEvent(new Event(event, { bubbles: true }))
  holder.remove()
  return true
}

async function share (options: ShareOptions): Promise<ShareResult> {
  if (!window.isSecureContext) return refusal('NotAllowedError', 'Permission denied')
  if (!policyAllows()) return refusal('NotAllowedError', 'Access to the feature "display-capture" is disallowed by permissions policy.')
  let reply: unknown
  try {
    reply = await ipcRenderer.invoke(DISPLAY_CAPTURE_PICK_CHANNEL, {
      type: 'pick', audio: options.audio, hints: options.hints, activation: (navigator as { userActivation?: { isActive?: boolean } }).userActivation?.isActive === true
    })
  } catch {
    return refusal('NotAllowedError', 'Permission denied')
  }
  const go = typeof reply === 'object' && reply !== null ? reply as { type?: unknown, nonce?: unknown } : {}
  if (go.type !== 'go' || typeof go.nonce !== 'string') return refusal('NotAllowedError', 'Permission denied')
  const nonce = go.nonce

  // One synchronous step: main holds the page's request until it has heard both messages, so it can tell this call
  // from any other request that arrives meanwhile. The second message waits a turn of the event loop: a call that
  // fails at once has failed before it and says so.
  let rejectedEarly = false
  let request: Promise<MediaStream>
  ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'arm', nonce })
  try {
    request = navigator.mediaDevices.getDisplayMedia({ video: options.video as boolean | MediaTrackConstraints, audio: options.audio ? options.audioConstraints as boolean | MediaTrackConstraints : false })
  } catch (error) {
    request = Promise.reject(error)
  }
  void request.catch(() => { rejectedEarly = true })
  setTimeout(() => { ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce, rejectedEarly }) }, 0)

  let stream: MediaStream
  try {
    stream = await request
  } catch (error) {
    // Main may already have started the share when it answered the request, and Chromium can still fail to start the
    // capture (a tab it cannot capture): no track will ever end for it, so main is told there is none.
    ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'tracks-ended', nonce })
    return errorOf(error)
  }
  const record: ShareRecord = { nonce, tracks: new Set() }
  records.set(nonce, record)
  for (const track of stream.getTracks()) keep(record, track)
  if (!handOver(stream, options.handOff, nonce)) {
    for (const track of stream.getTracks()) track.stop()
    settle(record)
    return refusal('AbortError', 'Failed to start capture')
  }
  return { ok: true, nonce }
}

/** A clone the main world made of a track this world handed out, passed over the DOM like the stream was. */
function onClone (event: Event): void {
  const holder = event.target
  if (!(holder instanceof HTMLVideoElement)) return
  const record = records.get(holder.getAttribute('data-orivon-share') ?? '')
  const stream = holder.srcObject
  if (record === undefined || !(stream instanceof MediaStream)) return
  for (const track of stream.getTracks()) keep(record, track)
}

/** Stop: every track of the share is stopped, and the page is told they ended, since a stop from here raises no event of its own. */
function onStop (_event: unknown, payload: unknown): void {
  const nonce = typeof payload === 'object' && payload !== null ? (payload as { nonce?: unknown }).nonce : undefined
  const record = typeof nonce === 'string' ? records.get(nonce) : undefined
  if (record === undefined) return
  for (const track of record.tracks) {
    track.stop()
    track.dispatchEvent(new Event('ended'))
  }
  settle(record)
}

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`, so it closes over nothing from this
 * module. `shareInOtherWorld` is the function above; `cloneEvent` is a name made fresh for each document.
 */
function wrapInMainWorld (shareInOtherWorld: (options: ShareOptions) => Promise<ShareResult>, cloneEvent: string): void {
  const devices = MediaDevices.prototype
  const nativeGetDisplayMedia = devices.getDisplayMedia
  const trackProto = MediaStreamTrack.prototype
  const nativeTrackClone = trackProto.clone
  const streamProto = MediaStream.prototype
  const nativeStreamClone = streamProto.clone
  if (typeof nativeGetDisplayMedia !== 'function') return
  const call = Reflect.apply
  /** The share each track or stream the page was handed belongs to. */
  const shares = new WeakMap<object, string>()
  const read = (source: unknown, key: string): unknown => {
    try { return source === null || source === undefined ? undefined : (source as Record<string, unknown>)[key] } catch { return undefined }
  }
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    try { return JSON.parse(JSON.stringify(value)) } catch { return true }
  }
  /** A hint the page gave as a string, or as `{ ideal }` / `{ exact }`, when it is one of `allowed`. */
  const choice = (value: unknown, allowed: readonly string[]): string | undefined => {
    const text = typeof value === 'string' ? value : (typeof read(value, 'ideal') === 'string' ? read(value, 'ideal') : read(value, 'exact'))
    return typeof text === 'string' && allowed.includes(text) ? text : undefined
  }
  const handOver = (stream: MediaStream, share: string): void => {
    const root = document.documentElement
    if (root === null) return
    const holder = document.createElement('video')
    holder.srcObject = stream
    holder.setAttribute('data-orivon-share', share)
    root.append(holder)
    holder.dispatchEvent(new Event(cloneEvent, { bubbles: true }))
    holder.remove()
  }

  devices.getDisplayMedia = new Proxy(nativeGetDisplayMedia, {
    apply (target, self: unknown, args: unknown[]): Promise<MediaStream> {
      if (!(self instanceof MediaDevices)) return call(target, self, args) as Promise<MediaStream>
      const options = args[0]
      if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
        return Promise.reject(new TypeError("Failed to execute 'getDisplayMedia' on 'MediaDevices': The provided value is not of type 'DisplayMediaStreamOptions'."))
      }
      const video = read(options, 'video')
      const audio = read(options, 'audio')
      if (video === false) {
        return Promise.reject(new TypeError("Failed to execute 'getDisplayMedia' on 'MediaDevices': Display capture requires video: video must not be false."))
      }
      const hints: Record<string, unknown> = {}
      const surface = choice(read(video, 'displaySurface'), ['browser', 'window', 'monitor'])
      if (surface !== undefined) hints.displaySurface = surface
      if (typeof read(options, 'preferCurrentTab') === 'boolean') hints.preferCurrentTab = read(options, 'preferCurrentTab')
      for (const key of ['selfBrowserSurface', 'systemAudio', 'monitorTypeSurfaces']) {
        const value = choice(read(options, key), ['include', 'exclude'])
        if (value !== undefined) hints[key] = value
      }
      const words = crypto.getRandomValues(new Uint32Array(4))
      const handOff = `orivon-share-${Array.from(words, (word) => word.toString(36)).join('')}`
      let stream: MediaStream | undefined
      const receive = (event: Event): void => {
        const holder = event.target as HTMLVideoElement | null
        const carried = holder === null ? null : holder.srcObject
        if (stream === undefined && carried instanceof MediaStream) stream = carried
      }
      window.addEventListener(handOff, receive, true)
      const asked = audio !== undefined && audio !== false && audio !== null
      return shareInOtherWorld({
        audio: asked, video: video === undefined || video === null ? true : copy(video), audioConstraints: asked ? copy(audio) : false, hints, handOff
      }).then((result) => {
        window.removeEventListener(handOff, receive, true)
        if (!result.ok) throw result.name === 'TypeError' ? new TypeError(result.message) : new DOMException(result.message, result.name)
        if (stream === undefined) throw new DOMException('Failed to start capture', 'AbortError')
        shares.set(stream, result.nonce)
        for (const track of stream.getTracks()) shares.set(track, result.nonce)
        return stream
      }, (error: unknown) => {
        window.removeEventListener(handOff, receive, true)
        throw error
      })
    }
  })

  // A clone of a track the page was handed keeps the capture alive after the original is stopped, so the other world
  // is given it too. A clone of a stream carries the clones of its tracks.
  trackProto.clone = new Proxy(nativeTrackClone, {
    apply (target, self: unknown, args: unknown[]): MediaStreamTrack {
      const clone = call(target, self, args) as MediaStreamTrack
      const share = self !== null && typeof self === 'object' ? shares.get(self) : undefined
      if (share !== undefined) {
        shares.set(clone, share)
        handOver(new MediaStream([clone]), share)
      }
      return clone
    }
  })
  streamProto.clone = new Proxy(nativeStreamClone, {
    apply (target, self: unknown, args: unknown[]): MediaStream {
      const clone = call(target, self, args) as MediaStream
      let share: string | undefined
      try {
        if (self instanceof MediaStream) for (const track of self.getTracks()) share ??= shares.get(track)
      } catch { /* a stream the page broke reads as not ours */ }
      if (share !== undefined) {
        shares.set(clone, share)
        for (const track of clone.getTracks()) shares.set(track, share)
        handOver(clone, share)
      }
      return clone
    }
  })
}

/** Fail-open like the other main-world installers: without the wrapper the page's call reaches the gate with no ticket and is refused. */
export function installDisplayCapture (): void {
  try {
    const words = crypto.getRandomValues(new Uint32Array(4))
    const cloneEvent = `orivon-clone-${Array.from(words, (word) => word.toString(36)).join('')}`
    window.addEventListener(cloneEvent, onClone, true)
    ipcRenderer.on(DISPLAY_CAPTURE_STOP_CHANNEL, onStop)
    contextBridge.executeInMainWorld({ func: wrapInMainWorld, args: [(options: ShareOptions) => share(options), cloneEvent] })
  } catch (error) {
    console.error('[orivon] screen sharing not wrapped', error)
  }
}
