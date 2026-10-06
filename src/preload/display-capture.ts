// Screen sharing for a page in a tab (ADR-0055, ADR-0061). The page's `getDisplayMedia` is wrapped in its own world:
// the wrapper asks, and after the person picked this world arms the ticket and runs the real call that the wrapper
// prepared in the page's world, so the page's `CaptureController` binds to it and the permission gate can tell that
// call from every other `media` request. The wrapper is not a boundary: a call that goes around it meets no ticket in
// main and is refused there. The wrapper reads the options Electron never passes to main, and the stream is kept
// here so that Stop reaches its tracks, clones included.
import { contextBridge, ipcRenderer } from 'electron'
import { DISPLAY_CAPTURE_CHANNEL, DISPLAY_CAPTURE_PICK_CHANNEL, DISPLAY_CAPTURE_STOP_CHANNEL } from '../main/channels.js'

/** What the main world asks of this one for a call: whether the page wants audio, and the hints the picker opens on. */
interface ShareOptions {
  readonly audio: boolean
  readonly hints: Record<string, unknown>
}

/** What the main world's call came to: the stream, held by a detached element, or the refusal read from its error. */
type CallOutcome = { readonly ok: true, readonly holder: unknown } | { readonly ok: false, readonly name: string, readonly message: string }

/**
 * Starts the real call in the main world, once, and hands its outcome to the callback, whose answer comes back to the
 * main world at once: the page's promise settles in the turn the call did, which a capture controller needs.
 */
type CallNow = (onSettled: (outcome: CallOutcome) => ShareResult) => void

/** `share` is the id the main world and the DOM hand-off name a share by; the ticket's nonce never leaves this world. */
type ShareResult = { readonly ok: true, readonly share: string } | { readonly ok: false, readonly name: string, readonly message: string }

/** The tracks one share handed to the page, originals and clones: a share has ended when all of them have. */
interface ShareRecord {
  readonly nonce: string
  readonly id: string
  readonly tracks: Set<MediaStreamTrack>
}

const POLL_MS = 1000
const REPORTED_NAMES: readonly string[] = ['NotAllowedError', 'AbortError', 'NotReadableError', 'NotFoundError']
const records = new Map<string, ShareRecord>()
const recordsById = new Map<string, ShareRecord>()
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
  recordsById.delete(record.id)
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

/** Whether the main world's call came back with a stream held by an element: anything else is a refusal. */
function isStream (outcome: unknown): boolean {
  if (typeof outcome !== 'object' || outcome === null || (outcome as { ok?: unknown }).ok !== true) return false
  const holder = (outcome as { holder?: unknown }).holder
  return typeof holder === 'object' && holder !== null && (holder as { srcObject?: unknown }).srcObject instanceof MediaStream
}

function failureOf (outcome: unknown): ShareResult {
  const read = (key: string): unknown => typeof outcome === 'object' && outcome !== null ? (outcome as Record<string, unknown>)[key] : undefined
  const name = read('name')
  const message = read('message')
  return refusal(typeof name === 'string' ? name : 'AbortError', typeof message === 'string' ? message : 'Failed to start capture')
}

/** The failure name main reads: one of the few it knows, and `AbortError` for any other. */
function reportedName (failure: ShareResult): string {
  return !failure.ok && REPORTED_NAMES.includes(failure.name) ? failure.name : 'AbortError'
}

/** A random name for a share that the page may see, so that what the page can read says nothing of the ticket. */
function randomName (prefix: string): string {
  const words = crypto.getRandomValues(new Uint32Array(4))
  return `${prefix}-${Array.from(words, (word) => word.toString(36)).join('')}`
}

async function share (options: ShareOptions, callNow: CallNow): Promise<ShareResult> {
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
  ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'arm', nonce })
  let concluded: ShareResult | undefined
  const conclude = (outcome: unknown): ShareResult => {
    concluded ??= receive(nonce, outcome)
    if (!concluded.ok) rejectedEarly = true
    return concluded
  }
  const verdict = new Promise<ShareResult>((resolve) => {
    try {
      callNow((outcome) => { const result = conclude(outcome); resolve(result); return result })
    } catch {
      resolve(conclude(undefined))
    }
  })
  setTimeout(() => { ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'called', nonce, rejectedEarly }) }, 0)
  return await verdict
}

/** What the real call came to, told to main and kept: the share's id for a stream, the refusal otherwise. */
function receive (nonce: string, outcome: unknown): ShareResult {
  const stream = isStream(outcome) ? (outcome as { holder: { srcObject: unknown } }).holder.srcObject : undefined
  if (!(stream instanceof MediaStream)) {
    // Main starts the share when it answers the request, before this call knows its outcome, and keeps it unconfirmed.
    // Chromium can still fail to start the capture (a tab it cannot capture), and a refusal here means the request main
    // served was another one's: either way main is told this call failed and why, and decides what ends.
    const failure = failureOf(outcome)
    ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'failed', nonce, name: reportedName(failure) })
    return failure
  }
  ipcRenderer.send(DISPLAY_CAPTURE_CHANNEL, { type: 'received', nonce })
  const record: ShareRecord = { nonce, id: randomName('orivon-id'), tracks: new Set() }
  records.set(nonce, record)
  recordsById.set(record.id, record)
  for (const track of stream.getTracks()) keep(record, track)
  return { ok: true, share: record.id }
}

/** A clone the main world made of a track this world handed out, passed over the DOM like the stream was. */
function onClone (event: Event): void {
  const holder = event.target
  if (!(holder instanceof HTMLVideoElement)) return
  const record = recordsById.get(holder.getAttribute('data-orivon-share') ?? '')
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
 * module. `shareInOtherWorld` is the function above; `cloneEvent` is a name made fresh for each document. The real
 * `getDisplayMedia` call is made here, by `callNow`, from natives captured before any page script ran, so that the
 * page's `CaptureController` binds to it (see src/main/display-capture/README.md, Design notes).
 */
function wrapInMainWorld (shareInOtherWorld: (options: ShareOptions, callNow: CallNow) => Promise<ShareResult>, cloneEvent: string): void {
  // `MediaDevices` is exposed to secure contexts only: an error page and a blank page have none, and nothing to wrap.
  if (typeof MediaDevices === 'undefined') return
  const devices = MediaDevices.prototype
  const nativeGetDisplayMedia = devices.getDisplayMedia
  const trackProto = MediaStreamTrack.prototype
  const nativeTrackClone = trackProto.clone
  const nativeStop = trackProto.stop
  const streamProto = MediaStream.prototype
  const nativeStreamClone = streamProto.clone
  const nativeGetTracks = streamProto.getTracks
  const nativeThen = Promise.prototype.then
  const nativeCreateElement = Document.prototype.createElement
  const setSource = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')?.set
  const domName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get
  const domMessage = Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get
  const ownDescriptor = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty
  const create = Object.create as (proto: null) => Record<PropertyKey, unknown>
  const keysOf = Object.keys
  const isArray = Array.isArray
  const NativeJSON = JSON
  const parse = JSON.parse
  const stringify = JSON.stringify
  const NativePromise = Promise
  const NativeDOMException = DOMException
  const NativeTypeError = TypeError
  if (typeof nativeGetDisplayMedia !== 'function' || typeof setSource !== 'function' || typeof domName !== 'function' || typeof domMessage !== 'function') return
  const call = Reflect.apply
  const construct = Reflect.construct
  /** The share each track or stream the page was handed belongs to. */
  const shares = new WeakMap<object, string>()
  const read = (source: unknown, key: string): unknown => {
    try { return source === null || source === undefined ? undefined : (source as Record<string, unknown>)[key] } catch { return undefined }
  }
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return typeof value === 'function' ? true : value
    try { return call(parse, NativeJSON, [call(stringify, NativeJSON, [value])]) } catch { return true }
  }
  /** The data of a copy with no prototype and no accessor, arrays included, so converting it for the real call runs no page code. */
  const bare = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return value
    const source = value as Record<string, unknown>
    if (isArray(value)) {
      const list: unknown[] = []
      for (let index = 0; index < value.length; index++) list[index] = bare(value[index])
      const iterate = (): unknown => {
        let next = 0
        const iterator = create(null)
        iterator.next = (): unknown => {
          const step = create(null)
          step.done = next >= list.length
          step.value = next < list.length ? list[next++] : undefined
          return step
        }
        return iterator
      }
      define(list, Symbol.iterator, { value: iterate })
      return list
    }
    const out = create(null)
    for (const key of keysOf(source)) out[key] = bare(source[key])
    return out
  }
  const bareCopy = (value: unknown): unknown => { try { return bare(copy(value)) } catch { return true } }
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
  /**
   * `then` on a native promise with the page unable to stand in for it: the promise names its own constructor and
   * species, so no `Promise` property the page changed is read.
   */
  const whenSettled = (promise: unknown, onValue: (value: never) => void, onReason: (reason: unknown) => void): void => {
    const Derived = function (this: unknown, executor: (resolve: () => void, reject: () => void) => void): void { executor(() => {}, () => {}) }
    define(Derived, Symbol.species, { value: Derived })
    define(promise, 'constructor', { value: Derived })
    call(nativeThen, promise, [onValue, onReason])
  }
  /** The name and message of a native rejection, read with the getters captured at install. */
  const refusalOf = (error: unknown): CallOutcome => {
    try {
      return { ok: false, name: call(domName, error, []) as string, message: call(domMessage, error, []) as string }
    } catch {
      // Not a DOMException: the conversion of the options failed, which is a TypeError whose message is its own property.
      let message: unknown
      try { message = ownDescriptor(error as object, 'message')?.value } catch { message = undefined }
      return { ok: false, name: 'TypeError', message: typeof message === 'string' ? message : 'Failed to start capture' }
    }
  }
  const refuse = (name: string, message: string): unknown =>
    name === 'TypeError' ? construct(NativeTypeError, [message]) : construct(NativeDOMException, [message, name])
  const stopAll = (stream: MediaStream): void => {
    try { for (const track of call(nativeGetTracks, stream, []) as MediaStreamTrack[]) call(nativeStop, track, []) } catch { /* nothing left to stop */ }
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
      const controller = read(options, 'controller')
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
      const asked = audio !== undefined && audio !== false && audio !== null
      // The options of the real call, built now so that converting them later reads data and runs no page code. A
      // controller is passed as given: the browser checks it is a `CaptureController` and says so when it is not.
      const real = create(null)
      real.video = video === undefined || video === null ? true : bareCopy(video)
      real.audio = asked ? bareCopy(audio) : false
      if (controller !== undefined) real.controller = controller
      /** The stream the real call returned, kept for the page until the other world has taken its tracks. */
      let kept: MediaStream | undefined
      let started = false
      return new NativePromise<MediaStream>((resolve, reject) => {
        let done = false
        const fail = (reason: unknown): void => {
          if (done) return
          done = true
          const stream = kept
          kept = undefined
          if (stream !== undefined) stopAll(stream)
          reject(reason)
        }
        const finish = (result: ShareResult): void => {
          if (done) return
          if (!result.ok) { fail(refuse(result.name, result.message)); return }
          const stream = kept
          if (stream === undefined) { fail(refuse('AbortError', 'Failed to start capture')); return }
          done = true
          shares.set(stream, result.share)
          for (const track of call(nativeGetTracks, stream, []) as MediaStreamTrack[]) shares.set(track, result.share)
          resolve(stream)
        }
        const callNow: CallNow = (onSettled) => {
          if (started) return
          started = true
          const settle = (outcome: CallOutcome): void => {
            try { finish(onSettled(outcome)) } catch { fail(refuse('AbortError', 'Failed to start capture')) }
          }
          try {
            whenSettled(call(nativeGetDisplayMedia, self, [real]), (stream: MediaStream) => {
              let holder: HTMLVideoElement
              try {
                holder = call(nativeCreateElement, document, ['video']) as HTMLVideoElement
                call(setSource, holder, [stream])
              } catch {
                stopAll(stream)
                settle({ ok: false, name: 'AbortError', message: 'Failed to start capture' })
                return
              }
              kept = stream
              settle({ ok: true, holder })
            }, (error) => { settle(refusalOf(error)) })
          } catch (error) {
            settle(refusalOf(error))
          }
        }
        try {
          // A refusal before the call, or a failure of the bridge, comes through the promise; once the call is made the
          // answer comes with its outcome.
          whenSettled(shareInOtherWorld({ audio: asked, hints }, callNow), (result: ShareResult) => { if (!started) finish(result) }, fail)
        } catch (error) {
          fail(error)
        }
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
    contextBridge.executeInMainWorld({ func: wrapInMainWorld, args: [(options: ShareOptions, callNow: CallNow) => share(options, callNow), cloneEvent] })
  } catch (error) {
    console.error('[orivon] screen sharing not wrapped', error)
  }
}
