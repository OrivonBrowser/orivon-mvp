import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipboard } from '../clipboard.js'
import { ElectronShimError } from '../errors.js'

/** A document that only dispatches: no DOM is needed to see what the shim does with a `paste` event. */
function pasteEvent (text: string | null): Event {
  const event = new Event('paste')
  const clipboardData = text === null ? null : { getData: (type: string) => (type === 'text/plain' ? text : '') }
  return Object.defineProperty(event, 'clipboardData', { value: clipboardData })
}

function setup (overrides: { writeText?: (text: string) => Promise<void>, noClipboard?: boolean } = {}) {
  const document = new EventTarget()
  const writeText = vi.fn(overrides.writeText ?? (async () => {}))
  const navigator = overrides.noClipboard === true ? {} : { clipboard: { writeText } }
  const warn = vi.fn()
  const clipboard = createClipboard({ document, navigator, warn })
  return { document, writeText, warn, clipboard }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('clipboard.writeText', () => {
  it('hands the text to navigator.clipboard and returns undefined, as Electron does', () => {
    const { clipboard, writeText } = setup()
    expect(clipboard.writeText('magnet:?xt=urn:btih:abc')).toBeUndefined()
    expect(writeText).toHaveBeenCalledWith('magnet:?xt=urn:btih:abc')
  })

  it('reports a rejected write on the console and never throws into the caller', async () => {
    const { clipboard, warn } = setup({ writeText: async () => { throw new DOMException('not focused', 'NotAllowedError') } })
    expect(() => clipboard.writeText('x')).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/clipboard\.writeText/)
  })

  it('reports a synchronous failure of the web call the same way', () => {
    const { clipboard, warn } = setup({ writeText: () => { throw new TypeError('boom') } })
    expect(() => clipboard.writeText('x')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reports a page without navigator.clipboard instead of throwing', () => {
    const { clipboard, warn } = setup({ noClipboard: true })
    expect(() => clipboard.writeText('x')).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('clipboard.readText', () => {
  it("answers '' when no paste is being dispatched", () => {
    const { clipboard } = setup()
    expect(clipboard.readText()).toBe('')
  })

  it('answers the pasted text from inside a paste listener the app registered', () => {
    const { clipboard, document } = setup()
    let seen: string | undefined
    document.addEventListener('paste', () => { seen = clipboard.readText() })
    document.dispatchEvent(pasteEvent('magnet:?xt=urn:btih:abc'))
    expect(seen).toBe('magnet:?xt=urn:btih:abc')
  })

  it('still answers it when the app\'s listener runs in a later turn of the same task and a microtask ran between listeners', async () => {
    const { clipboard, document } = setup()
    const seen: string[] = []
    document.addEventListener('paste', () => { void Promise.resolve().then(() => { seen.push(clipboard.readText()) }) })
    document.dispatchEvent(pasteEvent('after a microtask'))
    await Promise.resolve()
    expect(seen).toEqual(['after a microtask'])
  })

  it("answers '' again once the paste is over", async () => {
    const { clipboard, document } = setup()
    document.dispatchEvent(pasteEvent('gone soon'))
    await vi.advanceTimersByTimeAsync(0)
    expect(clipboard.readText()).toBe('')
  })

  it("answers '' for a paste that carries no text/plain or no clipboardData", () => {
    const { clipboard, document } = setup()
    const seen: string[] = []
    document.addEventListener('paste', () => { seen.push(clipboard.readText()) })
    document.dispatchEvent(pasteEvent(null))
    document.dispatchEvent(pasteEvent(''))
    expect(seen).toEqual(['', ''])
  })

  it('takes the text before an app listener that stops propagation can hide the event', () => {
    const { clipboard, document } = setup()
    let seen: string | undefined
    document.addEventListener('paste', (event) => { event.stopImmediatePropagation(); seen = clipboard.readText() })
    document.dispatchEvent(pasteEvent('captured first'))
    expect(seen).toBe('captured first')
  })

  it('ignores the type argument Electron accepts', () => {
    const { clipboard, document } = setup()
    let seen: string | undefined
    document.addEventListener('paste', () => { seen = clipboard.readText('selection') })
    document.dispatchEvent(pasteEvent('text'))
    expect(seen).toBe('text')
  })
})

describe('the rest of clipboard', () => {
  it.each(['clear', 'has', 'read', 'write', 'readHTML', 'writeImage', 'availableFormats'])('%s: reading it is safe; calling it throws a named unimplemented error', (member) => {
    const { clipboard } = setup()
    const each = clipboard as unknown as Record<string, () => unknown>
    expect(() => each[member]).not.toThrow()
    try {
      each[member]!()
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ElectronShimError)
      expect((error as ElectronShimError).reason).toBe('unimplemented')
      expect((error as ElectronShimError).api).toBe(`clipboard.${member}`)
    }
  })
})
