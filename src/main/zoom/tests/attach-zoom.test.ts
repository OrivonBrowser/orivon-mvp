import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachZoom } from '../attach-zoom.js'
import type { ZoomService } from '../zoom-service.js'

class FakeContents extends EventEmitter {
  factor = 1
  url = ''
  destroyed = false
  readonly setZoomMode = vi.fn()
  getURL (): string { return this.url }
  getZoomFactor (): number { return this.factor }
  setZoomFactor (factor: number): void { this.factor = factor }
  isDestroyed (): boolean { return this.destroyed }
}

function fakeZoom (levels: Record<string, number>): { zoom: ZoomService, step: ReturnType<typeof vi.fn>, change: () => void } {
  const listeners = new Set<() => void>()
  const step = vi.fn()
  const zoom = {
    percentFor: (origin: string | null) => (origin === null ? 100 : levels[origin] ?? 100),
    step,
    onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  } as unknown as ZoomService
  return { zoom, step, change: () => { for (const listener of listeners) listener() } }
}

function attached (levels: Record<string, number>, isTab = true): { contents: FakeContents, step: ReturnType<typeof vi.fn>, change: () => void } {
  const contents = new FakeContents()
  const { zoom, step, change } = fakeZoom(levels)
  attachZoom(contents as unknown as WebContents, zoom, { isTab: () => isTab })
  return { contents, step, change }
}

describe('attachZoom', () => {
  it('takes zoom out of the browser\'s hands', () => {
    expect(attached({}).contents.setZoomMode).toHaveBeenCalledWith('manual')
  })

  it('shows a page at its site\'s level as it commits, and back to normal for a page with no site', () => {
    const { contents } = attached({ 'https://a.example': 150 })
    contents.emit('did-navigate', {}, 'https://a.example/page')
    expect(contents.factor).toBe(1.5)
    contents.emit('did-navigate', {}, 'file:///dashboard/index.html')
    expect(contents.factor).toBe(1)
  })

  it('follows a change of the level while the page stays', () => {
    const levels: Record<string, number> = { 'https://a.example': 100 }
    const { contents, change } = attached(levels)
    contents.url = 'https://a.example/'
    levels['https://a.example'] = 200
    change()
    expect(contents.factor).toBe(2)
  })

  it('turns a step from the mouse wheel into a step for the site', () => {
    const { contents, step } = attached({})
    contents.url = 'https://a.example/page'
    contents.emit('zoom-changed', {}, 'in')
    contents.url = 'orivon://settings/'
    contents.emit('zoom-changed', {}, 'out')
    expect(step).toHaveBeenCalledExactlyOnceWith('https://a.example', 'in')
  })

  it('leaves a view that is not a tab at normal size, and does nothing once destroyed', () => {
    const chrome = attached({ 'https://a.example': 150 }, false)
    chrome.contents.emit('did-navigate', {}, 'https://a.example/')
    chrome.contents.emit('zoom-changed', {}, 'in')
    expect(chrome.contents.factor).toBe(1)
    expect(chrome.step).not.toHaveBeenCalled()

    const gone = attached({ 'https://a.example': 150 })
    gone.contents.destroyed = true
    gone.contents.emit('did-navigate', {}, 'https://a.example/')
    expect(gone.contents.factor).toBe(1)
  })

  it('stops listening for level changes once the page is gone', () => {
    const { contents, change } = attached({ 'https://a.example': 150 })
    contents.url = 'https://a.example/'
    contents.emit('destroyed')
    change()
    expect(contents.factor).toBe(1)
  })
})
