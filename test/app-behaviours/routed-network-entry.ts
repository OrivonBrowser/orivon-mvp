// Bundled by ./e2e-app-routed-network.test.ts into the fixture app's script: the network calls an app makes, each
// answered with plain data about what happened, so the test can say where the traffic went. The page's own
// `orivon.net` is used directly, and the browser's own WebSocket, image loader, <webview> and RTCPeerConnection, which
// are the other ways an app's traffic can leave.

export interface Attempt {
  readonly ok: boolean
  readonly detail: string
  readonly code?: string
}

interface OrivonSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly localAddress?: string
  readonly localPort?: number
  close: () => Promise<void>
}

interface OrivonDatagramSocket {
  readonly readable: ReadableStream<{ data: Uint8Array, address: string, port: number }>
  readonly writable: WritableStream<{ data: Uint8Array, address: string, port: number, family: 'IPv4' | 'IPv6' }>
  readonly localAddress: string
  close: () => Promise<void>
}

interface OrivonNet {
  connect: (opts: { host: string, port: number }) => Promise<OrivonSocket>
  connectSecure: (opts: { host: string, port: number }) => Promise<OrivonSocket>
  listen: (opts: { port: number, scope?: 'local' | 'network' }) => Promise<{ readonly connections: ReadableStream<OrivonSocket>, localAddress: string, localPort: number, close: () => Promise<void> }>
  udpBind: (opts: { port: number, scope?: 'local' | 'network' }) => Promise<OrivonDatagramSocket>
  lookup: (opts: { hostname: string }) => Promise<ReadonlyArray<{ address: string }>>
}

const net = (): OrivonNet => (globalThis as unknown as { orivon: { net: OrivonNet } }).orivon.net
const TIMEOUT_MS = 8_000

function failed (error: unknown): Attempt {
  const { code, message } = error as { code?: string, message?: string }
  return { ok: false, detail: String(message ?? error), ...(code === undefined ? {} : { code }) }
}

async function firstChunk (readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader()
  const timer = new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error('no answer')) }, TIMEOUT_MS) })
  const chunk = await Promise.race([reader.read(), timer])
  reader.releaseLock()
  return chunk.done === true ? '' : new TextDecoder().decode(chunk.value)
}

/** Connects, sends `ping` and reads what comes back. The server echoes, or greets first when `greets`. */
async function exchange (open: () => Promise<OrivonSocket>, greets: boolean): Promise<Attempt> {
  try {
    const socket = await open()
    try {
      if (!greets) {
        const writer = socket.writable.getWriter()
        await writer.write(new TextEncoder().encode('ping'))
        writer.releaseLock()
      }
      return { ok: true, detail: await firstChunk(socket.readable) }
    } finally {
      await socket.close().catch(() => {})
    }
  } catch (error) {
    return failed(error)
  }
}

async function tcp (host: string, port: number): Promise<Attempt> {
  return await exchange(async () => await net().connect({ host, port }), false)
}

async function secure (host: string, port: number): Promise<Attempt> {
  return await exchange(async () => await net().connectSecure({ host, port }), true)
}

async function datagram (host: string, port: number): Promise<Attempt> {
  try {
    const socket = await net().udpBind({ port: 0, scope: 'local' })
    try {
      const writer = socket.writable.getWriter()
      await writer.write({ data: new TextEncoder().encode('ping'), address: host, port, family: 'IPv4' })
      writer.releaseLock()
      const reader = socket.readable.getReader()
      const timer = new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error('no answer')) }, TIMEOUT_MS) })
      const reply = await Promise.race([reader.read(), timer])
      return { ok: true, detail: reply.done === true ? '' : new TextDecoder().decode(reply.value.data) }
    } finally {
      await socket.close().catch(() => {})
    }
  } catch (error) {
    return failed(error)
  }
}

async function webSocket (url: string): Promise<Attempt> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { resolve({ ok: false, detail: 'no answer' }) }, TIMEOUT_MS)
    try {
      const socket = new WebSocket(url)
      socket.onmessage = (event) => { clearTimeout(timer); resolve({ ok: true, detail: String(event.data) }); socket.close() }
      socket.onerror = () => { clearTimeout(timer); resolve({ ok: false, detail: 'error' }) }
    } catch (error) {
      clearTimeout(timer)
      resolve(failed(error))
    }
  })
}

async function image (url: string): Promise<Attempt> {
  return await new Promise((resolve) => {
    const picture = new Image()
    const timer = setTimeout(() => { resolve({ ok: false, detail: 'no answer' }) }, TIMEOUT_MS)
    picture.onload = () => { clearTimeout(timer); resolve({ ok: true, detail: `${String(picture.naturalWidth)}x${String(picture.naturalHeight)}` }) }
    picture.onerror = () => { clearTimeout(timer); resolve({ ok: false, detail: 'error' }) }
    picture.src = url
  })
}

/** Shows `url` in a `<webview>`, which loads it with Chromium's own network stack. */
async function embed (url: string): Promise<Attempt> {
  return await new Promise((resolve) => {
    const view = document.createElement('webview') as HTMLElement & { src: string, getTitle: () => string }
    const timer = setTimeout(() => { resolve({ ok: false, detail: 'no answer' }) }, TIMEOUT_MS * 2)
    view.addEventListener('did-finish-load', () => { clearTimeout(timer); resolve({ ok: true, detail: view.getTitle() }) })
    view.addEventListener('did-fail-load', (event) => { clearTimeout(timer); resolve({ ok: false, detail: `failed ${String((event as unknown as { errorCode: number }).errorCode)}` }) })
    view.src = url
    view.style.width = '300px'
    view.style.height = '200px'
    document.body.appendChild(view)
  })
}

async function listen (scope: 'local' | 'network'): Promise<Attempt> {
  try {
    const server = await net().listen({ port: 0, scope })
    await server.close().catch(() => {})
    return { ok: true, detail: server.localAddress }
  } catch (error) {
    return failed(error)
  }
}

/** Listens on loopback at `port`, greets the first connection, and connects to it from the same page. */
async function loopback (port: number): Promise<Attempt> {
  try {
    const server = await net().listen({ port, scope: 'local' })
    try {
      void (async () => {
        const { value } = await server.connections.getReader().read()
        if (value === undefined) return
        const writer = value.writable.getWriter()
        await writer.write(new TextEncoder().encode('hello from the listener'))
        await value.close()
      })().catch(() => {})
      const heard = await exchange(async () => await net().connect({ host: '127.0.0.1', port }), true)
      return { ...heard, detail: `${server.localAddress}:${heard.detail}` }
    } finally {
      await server.close().catch(() => {})
    }
  } catch (error) {
    return failed(error)
  }
}

async function lookup (hostname: string): Promise<Attempt> {
  try {
    return { ok: true, detail: (await net().lookup({ hostname })).map((entry) => entry.address).join(',') }
  } catch (error) {
    return failed(error)
  }
}

/** Gathers ICE candidates against a STUN server for a few seconds. `detail` is how many arrived. */
async function candidates (stunPort: number): Promise<Attempt> {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${String(stunPort)}` }] })
  const gathered: string[] = []
  peer.onicecandidate = (event) => { if (event.candidate !== null) gathered.push(event.candidate.candidate) }
  peer.createDataChannel('probe')
  await peer.setLocalDescription(await peer.createOffer())
  await new Promise((resolve) => { setTimeout(resolve, 3_500) })
  peer.close()
  return { ok: true, detail: String(gathered.length) }
}

let held: OrivonSocket | undefined
let heldEnded = false

/** Opens a connection and keeps it, to see whether it survives a change of route. */
async function hold (host: string, port: number): Promise<Attempt> {
  try {
    held = await net().connect({ host, port })
    heldEnded = false
    void held.readable.getReader().read().then(() => { heldEnded = true }, () => { heldEnded = true })
    return { ok: true, detail: 'open' }
  } catch (error) {
    return failed(error)
  }
}

function heldState (): Attempt {
  return { ok: !heldEnded, detail: heldEnded ? 'closed' : 'open' }
}

;(globalThis as unknown as { routedNetworkE2e: unknown }).routedNetworkE2e = { tcp, secure, datagram, webSocket, image, embed, listen, loopback, lookup, candidates, hold, heldState }
