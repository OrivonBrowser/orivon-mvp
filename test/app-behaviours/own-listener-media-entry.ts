// Bundled against the shim by ./e2e-app-own-listener-media.test.ts into a fixture page's script: an
// ordinary Node-shaped app that runs `http.createServer` inside its page and points its own media
// element and image at that server, the way a torrent client streams a file to its `<video>`.
// `location.search` names the port to listen on and a second server the test runs outside the page,
// which the same elements try to load too.

import http from 'http'
import { GIF, silentWav } from './own-listener-media-bytes.js'

export type Loaded = 'loaded' | 'error' | 'timeout'

export interface OwnListenerMediaResult {
  readonly port?: number
  readonly ownAudio?: Record<string, Loaded>
  readonly ownImage?: Record<string, Loaded>
  readonly outsideAudio?: Record<string, Loaded>
  readonly outsideImage?: Record<string, Loaded>
  readonly error?: string
}

const WAV = silentWav()
const TIMEOUT_MS = 8_000

async function loadAudio (url: string): Promise<Loaded> {
  return await new Promise((resolve) => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.muted = true
    const timer = setTimeout(() => { resolve('timeout') }, TIMEOUT_MS)
    audio.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(audio.readyState >= 2 ? 'loaded' : 'error') })
    audio.addEventListener('error', () => { clearTimeout(timer); resolve('error') })
    audio.src = url
    audio.load()
  })
}

async function loadImage (url: string): Promise<Loaded> {
  return await new Promise((resolve) => {
    const image = new Image()
    const timer = setTimeout(() => { resolve('timeout') }, TIMEOUT_MS)
    image.addEventListener('load', () => { clearTimeout(timer); resolve(image.naturalWidth === 1 ? 'loaded' : 'error') })
    image.addEventListener('error', () => { clearTimeout(timer); resolve('error') })
    image.src = url
  })
}

async function both (hosts: readonly string[], port: number | string, load: (url: string) => Promise<Loaded>, path: string): Promise<Record<string, Loaded>> {
  const out: Record<string, Loaded> = {}
  for (const host of hosts) out[host] = await load(`http://${host}:${String(port)}${path}`)
  return out
}

const HOSTS = ['127.0.0.1', 'localhost'] as const

async function run (): Promise<OwnListenerMediaResult> {
  const query = new URLSearchParams(location.search)
  const wanted = Number(query.get('port'))
  const outside = query.get('outside') ?? ''
  const server = http.createServer((req, res) => {
    const wav = req.url?.startsWith('/a.wav') === true
    res.writeHead(200, { 'Content-Type': wav ? 'audio/wav' : 'image/gif', 'Content-Length': String((wav ? WAV : GIF).length), 'Cache-Control': 'no-store' })
    res.end(wav ? WAV : GIF)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(wanted, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  return {
    port,
    ownAudio: await both(HOSTS, port, loadAudio, '/a.wav'),
    ownImage: await both(HOSTS, port, loadImage, '/a.gif'),
    outsideAudio: await both(HOSTS, outside, loadAudio, '/a.wav'),
    outsideImage: await both(HOSTS, outside, loadImage, '/a.gif')
  }
}

;(globalThis as unknown as { ownListenerMediaResult: Promise<OwnListenerMediaResult> }).ownListenerMediaResult =
  run().catch((error: unknown) => ({ error: String((error as Error)?.stack ?? error) }))
