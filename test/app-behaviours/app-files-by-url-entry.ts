// Bundled against the shim by ./e2e-app-files-by-url.test.ts into a fixture page's script: a Node-shaped
// Electron app that writes an image and a short sound into its own files with `fs`, then shows them by
// URL the two ways such an app does: a root-absolute `/orivon/app/<path>` (an `<img>`, a CSS image) and
// a `file:///orivon/app/<path>` built from a path (`new Audio`, `.src`, `setAttribute`, `<source>`).
// `window.appFilesByUrl.probe(url)` loads one more image, for the traversal and symlink checks, and
// `showCssImage()` sets a CSS background image on request.

import * as fs from 'fs'
import 'electron'
import { GIF, silentWav } from './own-listener-media-bytes.js'

export type Loaded = 'loaded' | 'error' | 'timeout'

export interface AppFilesByUrlResult {
  readonly rootImage?: Loaded
  readonly fileUrlImageAttribute?: Loaded
  readonly audioConstructor?: Loaded
  readonly audioProperty?: Loaded
  readonly audioRootPath?: Loaded
  readonly audioSource?: Loaded
  readonly fileUrlOutsideRoot?: Loaded
  readonly hostOnlyImage?: Loaded
  readonly error?: string
}

const TIMEOUT_MS = 10_000
const POSTER = '.config/Posters/mark.gif'
const SOUND = 'sound/add.wav'

function settle (setUp: (done: (outcome: Loaded) => void) => void): Promise<Loaded> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve('timeout') }, TIMEOUT_MS)
    setUp((outcome) => { clearTimeout(timer); resolve(outcome) })
  })
}

async function loadImage (configure: (image: HTMLImageElement, url: string) => void, url: string): Promise<Loaded> {
  return await settle((done) => {
    const image = document.createElement('img')
    image.addEventListener('load', () => { done(image.naturalWidth > 0 ? 'loaded' : 'error') })
    image.addEventListener('error', () => { done('error') })
    configure(image, url)
  })
}

const byProperty = (image: HTMLImageElement, url: string): void => { image.src = url }
const byAttribute = (image: HTMLImageElement, url: string): void => { image.setAttribute('src', url) }

async function loadAudio (configure: (audio: HTMLAudioElement, url: string) => void, url: string): Promise<Loaded> {
  return await settle((done) => {
    const audio = document.createElement('audio')
    audio.preload = 'auto'
    audio.muted = true
    audio.addEventListener('loadeddata', () => { done(audio.readyState >= 2 ? 'loaded' : 'error') })
    audio.addEventListener('error', () => { done('error') })
    configure(audio, url)
    audio.load()
  })
}

async function run (): Promise<AppFilesByUrlResult> {
  await fs.promises.mkdir('.config/Posters', { recursive: true })
  await fs.promises.mkdir('sound', { recursive: true })
  await fs.promises.mkdir('css', { recursive: true })
  await fs.promises.writeFile(POSTER, GIF)
  await fs.promises.writeFile(SOUND, silentWav())
  await fs.promises.writeFile('css/bg.gif', GIF)

  const probeSound = `file:///orivon/app/${SOUND}`

  const source = await settle((done) => {
    const audio = document.createElement('audio')
    const element = document.createElement('source')
    audio.preload = 'auto'
    audio.muted = true
    audio.addEventListener('loadeddata', () => { done(audio.readyState >= 2 ? 'loaded' : 'error') })
    element.addEventListener('error', () => { done('error') })
    element.setAttribute('src', probeSound)
    audio.append(element)
    audio.load()
  })

  return {
    rootImage: await loadImage(byProperty, `/orivon/app/${POSTER}`),
    fileUrlImageAttribute: await loadImage(byAttribute, `file:///orivon/app/${POSTER}`),
    audioConstructor: await settle((done) => {
      const audio = new Audio(probeSound)
      audio.muted = true
      audio.addEventListener('loadeddata', () => { done(audio.readyState >= 2 ? 'loaded' : 'error') })
      audio.addEventListener('error', () => { done('error') })
    }),
    audioProperty: await loadAudio((audio, url) => { audio.src = url }, probeSound),
    audioRootPath: await loadAudio((audio, url) => { audio.src = url }, `/orivon/app/${SOUND}`),
    audioSource: source,
    fileUrlOutsideRoot: await loadImage(byProperty, 'file:///etc/hostname'),
    hostOnlyImage: await loadImage(byProperty, '/orivon/app/host-only.svg')
  }
}

;(globalThis as unknown as { appFilesByUrl: unknown }).appFilesByUrl = {
  result: run().catch((error: unknown) => ({ error: String((error as Error)?.stack ?? error) })),
  probe: async (url: string): Promise<Loaded> => await loadImage(byProperty, url),
  /** The request itself is what the spec watches for: a CSS image has no load event to wait on. */
  showCssImage: (): void => {
    const box = document.createElement('div')
    box.style.cssText = "width:20px;height:20px;background-image:url('/orivon/app/css/bg.gif')"
    document.body.append(box)
  }
}
