import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForPicturesScript, whenPainted } from '../first-paint.js'

interface Stage {
  readonly backgrounds: { root: string, layer: string, body: string }
  /** Milliseconds each picture takes to decode, or `fail`. */
  readonly decodeMs: (src: string) => number | 'fail'
  readonly decodeLimitMs: number
  /** When the browser reports the first content presented; `never` for a page loaded while hidden. */
  readonly presentedAfterMs: number | 'never'
  readonly pageAgeMs?: number
  readonly presentLimitMs?: number
}

/** Runs the page script against a stand-in page, and logs what it did in order. */
function runScript (stage: Stage): { done: Promise<void>, log: string[] } {
  const log: string[] = []
  const style = (backgroundImage: string): { backgroundImage: string } => ({ backgroundImage })
  class FakeImage {
    src = ''
    decode (): Promise<void> {
      const ms = stage.decodeMs(this.src)
      log.push(`decode ${this.src}`)
      if (ms === 'fail') return Promise.reject(new Error('EncodingError'))
      return new Promise((resolve) => setTimeout(() => { log.push(`decoded ${this.src}`); resolve() }, ms))
    }
  }
  class FakeObserver {
    constructor (private readonly callback: (list: { getEntriesByName: (name: string) => unknown[] }, observer: FakeObserver) => void) {}
    observe (): void {
      log.push('observe paint')
      if (stage.presentedAfterMs === 'never') return
      setTimeout(() => { log.push('presented'); this.callback({ getEntriesByName: (name) => name === 'first-contentful-paint' ? [{}] : [] }, this) }, stage.presentedAfterMs)
    }

    disconnect (): void {}
  }
  const sandbox = {
    document: { documentElement: 'root', body: 'body' },
    getComputedStyle: (element: string, pseudo?: string) => style(pseudo === '::before' ? stage.backgrounds.layer : element === 'root' ? stage.backgrounds.root : stage.backgrounds.body),
    Image: FakeImage,
    PerformanceObserver: FakeObserver,
    performance: { now: () => stage.pageAgeMs ?? 100 },
    setTimeout,
    requestAnimationFrame: (callback: () => void) => { log.push('frame'); setTimeout(callback, 1) }
  }
  const done = (runInNewContext(waitForPicturesScript(stage.decodeLimitMs, stage.presentLimitMs), sandbox) as Promise<void>).then(() => { log.push('released') })
  return { done, log }
}

function fakePage (url: string, loading: boolean, frames: () => Promise<void> = async () => {}): EventEmitter & { getURL: () => string, isLoading: () => boolean, executeJavaScript: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { getURL: () => url, isLoading: () => loading, executeJavaScript: vi.fn(frames) })
}

afterEach(() => { vi.useRealTimers() })

describe('waitForPicturesScript', () => {
  const backgrounds = {
    root: 'none',
    layer: 'linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5)), url("file:///app/full.webp"), url("data:image/webp;base64,AAAA")',
    body: 'url(file:///app/body.webp)'
  }
  const stage: Stage = { backgrounds, decodeMs: () => 5, decodeLimitMs: 500, presentedAfterMs: 20 }

  it('decodes every picture of the root, its ::before layer and the body, then runs two frames, then waits for the presented report', async () => {
    const { done, log } = runScript(stage)
    await done
    expect(log.filter((line) => line.startsWith('decode '))).toEqual([
      'decode file:///app/full.webp', 'decode data:image/webp;base64,AAAA', 'decode file:///app/body.webp'
    ])
    const at = (entry: string): number => log.indexOf(entry)
    expect(at('decoded file:///app/full.webp')).toBeLessThan(at('frame'))
    expect(at('decoded data:image/webp;base64,AAAA')).toBeLessThan(at('frame'))
    expect(at('decoded file:///app/body.webp')).toBeLessThan(at('frame'))
    expect(log.filter((line) => line === 'frame')).toHaveLength(2)
    expect(at('presented')).toBeGreaterThan(at('frame'))
    expect(log[log.length - 1]).toBe('released')
  })

  it('does not wait on the pictures for longer than its limit, nor on one that cannot be decoded', async () => {
    const { done, log } = runScript({ ...stage, decodeMs: (src) => src.includes('full') ? 2_000 : src.includes('body') ? 'fail' : 1, decodeLimitMs: 30 })
    await done
    expect(log).not.toContain('decoded file:///app/full.webp')
    expect(log[log.length - 1]).toBe('released')
  })

  it('does not wait on the presented report for longer than its limit', async () => {
    const { done, log } = runScript({ ...stage, presentedAfterMs: 'never', presentLimitMs: 30 })
    await done
    expect(log).not.toContain('presented')
    expect(log[log.length - 1]).toBe('released')
  })

  it('does not wait on the presented report for a page that has been up a while: one loaded while hidden never makes it', async () => {
    const { done, log } = runScript({ ...stage, presentedAfterMs: 'never', presentLimitMs: 10_000, pageAgeMs: 5_000 })
    await done
    expect(log).not.toContain('observe paint')
    expect(log[log.length - 1]).toBe('released')
  })

  it('goes straight to the frames for a page with no picture', async () => {
    const { done, log } = runScript({ ...stage, backgrounds: { root: 'none', layer: 'none', body: 'none' } })
    await done
    expect(log.some((line) => line.startsWith('decode'))).toBe(false)
    expect(log.filter((line) => line === 'frame')).toHaveLength(2)
  })
})

describe('whenPainted', () => {
  it('waits for the document to be ready, then for two animation frames', async () => {
    const page = fakePage('', false)
    let resolved = false
    const done = whenPainted(page as never).then(() => { resolved = true })
    await Promise.resolve()
    expect(page.executeJavaScript).not.toHaveBeenCalled()
    expect(resolved).toBe(false)
    page.emit('dom-ready')
    await done
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(page.executeJavaScript.mock.calls[0]?.[0]).toMatch(/requestAnimationFrame\(\(\) => requestAnimationFrame/)
  })

  it('goes straight to the frames for a page that loaded while it was off the screen', async () => {
    const page = fakePage('http://127.0.0.1/', false)
    await whenPainted(page as never)
    expect(page.executeJavaScript).toHaveBeenCalledTimes(1)
  })

  it('gives up after the limit when the page never becomes ready, and leaves no listener behind', async () => {
    vi.useFakeTimers()
    const page = fakePage('', false)
    const done = whenPainted(page as never, 500)
    await vi.advanceTimersByTimeAsync(500)
    await done
    expect(page.listenerCount('dom-ready')).toBe(0)
    expect(page.listenerCount('destroyed')).toBe(0)
  })

  it('resolves when the page is destroyed, and when the script cannot run', async () => {
    const gone = fakePage('', false)
    const first = whenPainted(gone as never)
    gone.emit('destroyed')
    await first
    const broken = fakePage('', false, async () => { throw new Error('Script failed to execute') })
    const second = whenPainted(broken as never)
    broken.emit('dom-ready')
    await second
  })
})
