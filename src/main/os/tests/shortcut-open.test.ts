import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { openShortcutSheet, shortcutAddressFor, shortcutHint, SHORTCUT_OVERLAY } from '../shortcut-open.js'

const page = (displayUrl: string, over: { isNewTab?: boolean, isInternal?: boolean } = {}): { isNewTab: boolean, isInternal: boolean, displayUrl: string } => ({ isNewTab: false, isInternal: false, displayUrl, ...over })

describe('shortcutAddressFor', () => {
  it('is an http or https page\'s address, normalised', () => {
    expect(shortcutAddressFor(page('https://Example.com'))).toBe('https://example.com/')
    expect(shortcutAddressFor(page('http://127.0.0.1:3000/x'))).toBe('http://127.0.0.1:3000/x')
  })

  it('is nothing for a protocol address, a shell page or the new-tab page', () => {
    expect(shortcutAddressFor(page('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'))).toBeUndefined()
    expect(shortcutAddressFor(page('orivon://settings', { isInternal: true }))).toBeUndefined()
    expect(shortcutAddressFor(page('https://example.com/', { isNewTab: true }))).toBeUndefined()
    expect(shortcutAddressFor(undefined)).toBeUndefined()
  })
})

describe('shortcutHint', () => {
  const web = page('https://example.com/')
  it('is null where the command does something', () => {
    expect(shortcutHint(web, 'linux', false)).toBeNull()
    expect(shortcutHint(web, 'win32', false)).toBeNull()
  })

  it('says why not, in order of what the person can change', () => {
    expect(shortcutHint(web, 'darwin', false)).toBe('Not available on macOS')
    expect(shortcutHint(web, 'linux', true)).toBe('Not available in a private window')
    expect(shortcutHint(page('orivon://settings', { isInternal: true }), 'linux', false)).toBe('No address')
    expect(shortcutHint(page('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/'), 'linux', false)).toBe('Web pages only')
  })
})

describe('openShortcutSheet', () => {
  const target = (url: string, title = 'T'): { window: Pick<ShellWindow, 'tabs' | 'overlays'>, show: ReturnType<typeof vi.fn> } => {
    const show = vi.fn()
    return { show, window: { tabs: { getState: () => ({ tabs: [{ id: 'a', ...page(url), title }], activeTabId: 'a' }) }, overlays: { show } } as never }
  }

  it('shows the sheet with the tab\'s own address and title', () => {
    const { window, show } = target('https://example.com/a', 'Example')
    openShortcutSheet(window, { isPrivate: false }, 'linux')
    expect(show).toHaveBeenCalledWith(SHORTCUT_OVERLAY, undefined, { url: 'https://example.com/a', title: 'Example' })
  })

  it('shows nothing where the command is unavailable', () => {
    const { window, show } = target('https://example.com/a')
    openShortcutSheet(window, { isPrivate: false }, 'darwin')
    openShortcutSheet(window, { isPrivate: true }, 'linux')
    expect(show).not.toHaveBeenCalled()
  })
})
