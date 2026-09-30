import { vi } from 'vitest'
// A download item that behaves like Electron's where the service can tell: events, getters, and the calls it makes.
import { EventEmitter } from 'node:events'
import type { DownloadItem, WebContents } from 'electron'

export class FakeItem extends EventEmitter {
  savePath = ''
  received = 0
  total: number
  paused = false
  resumable = false
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' = 'progressing'
  speed = 0
  readonly setSavePath = vi.fn((path: string) => { this.savePath = path })
  readonly setSaveDialogOptions = vi.fn()
  readonly cancel = vi.fn(() => { this.state = 'cancelled' })
  readonly pause = vi.fn(() => { this.paused = true })
  readonly resume = vi.fn(() => { this.paused = false })

  constructor (readonly name: string, readonly chain: string[], readonly mime = 'application/octet-stream', total = 100, private readonly gesture = true) {
    super()
    this.total = total
  }

  getFilename (): string { return this.name }
  getURLChain (): string[] { return this.chain }
  getURL (): string { return this.chain.at(-1) ?? '' }
  getMimeType (): string { return this.mime }
  getTotalBytes (): number { return this.total }
  getReceivedBytes (): number { return this.received }
  getSavePath (): string { return this.savePath }
  getCurrentBytesPerSecond (): number { return this.speed }
  isPaused (): boolean { return this.paused }
  canResume (): boolean { return this.resumable }
  hasUserGesture (): boolean { return this.gesture }
  getState (): string { return this.state }

  progress (received: number): void {
    this.received = received
    this.emit('updated', {}, 'progressing')
  }

  finish (state: 'completed' | 'cancelled' | 'interrupted'): void {
    this.state = state
    if (state === 'completed') this.received = this.total
    this.emit('done', {}, state)
  }

  asItem (): DownloadItem { return this as unknown as DownloadItem }
}

export function fakeContents (id: number, url = 'https://site.example/page'): WebContents {
  return { id, getURL: () => url, isDestroyed: () => false } as unknown as WebContents
}
