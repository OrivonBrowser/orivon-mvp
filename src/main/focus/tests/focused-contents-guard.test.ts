import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

vi.mock('electron', () => ({ webContents: {} }))

const { focusedAmong, installFocusedContentsGuard } = await import('../focused-contents-guard.js')

type Kind = ReturnType<WebContents['getType']>
interface Fake { id: number, isDestroyed: () => boolean, getType: () => Kind, isFocused: () => boolean }

/** `isFocused` on an offscreen one throws, standing in for the segfault. */
function contents (id: number, type: Kind, focused: boolean, destroyed = false): Fake {
  return {
    id,
    isDestroyed: () => destroyed,
    getType: () => type,
    isFocused: () => {
      if (type === 'offscreen' || destroyed) throw new Error(`isFocused asked of ${type}${destroyed ? ' (destroyed)' : ''}`)
      return focused
    }
  }
}

describe('focusedAmong', () => {
  it('never asks an offscreen or destroyed contents', () => {
    const page = contents(3, 'browserView', true)
    expect(focusedAmong([contents(1, 'offscreen', true), contents(2, 'window', true, true), page])?.id).toBe(3)
  })

  it('answers null when nothing holds the keyboard', () => {
    expect(focusedAmong([contents(1, 'offscreen', false), contents(2, 'browserView', false)])).toBeNull()
  })

  it('prefers a focused webview over the page that embeds it, as Electron does', () => {
    expect(focusedAmong([contents(1, 'browserView', true), contents(2, 'webview', true)])?.id).toBe(2)
  })

  it('keeps the first focused one otherwise', () => {
    expect(focusedAmong([contents(1, 'browserView', true), contents(2, 'window', true)])?.id).toBe(1)
  })
})

describe('installFocusedContentsGuard', () => {
  it('replaces the module lookup so Electron menus reach the guarded one', () => {
    const all = [contents(1, 'offscreen', true), contents(2, 'browserView', true)]
    const module = { getAllWebContents: () => all, getFocusedWebContents: () => { throw new Error('unguarded') } }
    installFocusedContentsGuard(module as never)
    expect((module.getFocusedWebContents() as unknown as Fake | null)?.id).toBe(2)
  })
})
