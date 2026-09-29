import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { WindowRegistry, type ShellWindow } from '../window-registry.js'

function fakeWindow (ownsTab: (contents: WebContents) => string | null): ShellWindow {
  return { window: {}, chrome: {}, tabs: { findTabIdByWebContents: ownsTab } } as unknown as ShellWindow
}

function liveWindow (state: { focused?: boolean, destroyed?: boolean } = {}): ShellWindow {
  const window = { isFocused: () => state.focused ?? false, isDestroyed: () => state.destroyed ?? false }
  return { window, chrome: {}, tabs: {} } as unknown as ShellWindow
}

const CONTENTS_A = {} as WebContents
const CONTENTS_B = {} as WebContents

describe('WindowRegistry', () => {
  it('finds a tab in whichever window holds it', () => {
    const registry = new WindowRegistry()
    const first = fakeWindow((c) => (c === CONTENTS_A ? 'tab-1' : null))
    const second = fakeWindow((c) => (c === CONTENTS_B ? 'tab-9' : null))
    registry.add(first)
    registry.add(second)

    expect(registry.findTab(CONTENTS_A)).toEqual({ window: first, tabId: 'tab-1' })
    expect(registry.findTab(CONTENTS_B)).toEqual({ window: second, tabId: 'tab-9' })
  })

  it('finds nothing for a webContents no window holds, such as a page that is not a tab', () => {
    const registry = new WindowRegistry()
    registry.add(fakeWindow(() => null))

    expect(registry.findTab({} as WebContents)).toBeNull()
  })

  it('forgets a window once its removal has run', () => {
    const registry = new WindowRegistry()
    const window = fakeWindow((c) => (c === CONTENTS_A ? 'tab-1' : null))
    const forget = registry.add(window)
    expect(registry.all()).toEqual([window])

    forget()

    expect(registry.all()).toEqual([])
    expect(registry.findTab(CONTENTS_A)).toBeNull()
  })

  it('returns the focused window over any other', () => {
    const registry = new WindowRegistry()
    const background = liveWindow()
    const active = liveWindow({ focused: true })
    registry.add(background)
    registry.add(active)

    expect(registry.focused()).toBe(active)
  })

  it('falls back to the newest live window when none has focus', () => {
    const registry = new WindowRegistry()
    const older = liveWindow()
    const newer = liveWindow()
    registry.add(older)
    registry.add(newer)

    expect(registry.focused()).toBe(newer)
  })

  it('skips a destroyed window even if the OS still reports it focused', () => {
    const registry = new WindowRegistry()
    const gone = liveWindow({ focused: true, destroyed: true })
    const survivor = liveWindow()
    registry.add(gone)
    registry.add(survivor)

    expect(registry.focused()).toBe(survivor)
  })

  it('returns undefined when no window is open', () => {
    const registry = new WindowRegistry()

    expect(registry.focused()).toBeUndefined()
  })
})
