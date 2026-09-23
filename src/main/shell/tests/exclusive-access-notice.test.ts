import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The window a tab is on screen in, and the notice shown there: both are
// replaced, so this reads only which message is shown and when.
const shown = vi.hoisted(() => [] as string[])
const windows = vi.hoisted(() => ({ showing: undefined as object | undefined }))
vi.mock('../showing-window.js', () => ({ windowShowing: () => windows.showing }))
vi.mock('../window-notice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../window-notice.js')>()
  return { ...actual, noticeForWindow: () => ({ show: (text: string) => { shown.push(text) } }) }
})
vi.mock('electron', () => ({}))

const { exclusiveAccessNotice, noteExclusiveAccess } = await import('../exclusive-access-notice.js')
const { NOTICES } = await import('../window-notice.js')

function fakeContents (): EventEmitter {
  return new EventEmitter()
}

beforeEach(() => {
  shown.length = 0
  windows.showing = {}
})

describe('exclusiveAccessNotice', () => {
  // In fullscreen, Escape already leaves fullscreen and the pointer lock
  // together, and window.ts shows that notice.
  it('tells a windowed page\'s person how to get the cursor back, and adds nothing in fullscreen', () => {
    expect(exclusiveAccessNotice('pointerLock', false)).toBe(NOTICES.pointerLock)
    expect(exclusiveAccessNotice('pointerLock', true)).toBeNull()
  })

  // Keyboard lock only takes effect in fullscreen, and there a page holding
  // Escape gets a single press: only holding the key still leaves.
  it('says to hold Escape once a fullscreen page holds the keyboard, and nothing outside fullscreen', () => {
    expect(exclusiveAccessNotice('keyboardLock', true)).toBe(NOTICES.holdEscToExitFullscreen)
    expect(exclusiveAccessNotice('keyboardLock', false)).toBeNull()
  })
})

describe('noteExclusiveAccess', () => {
  it('shows the pointer notice in the window showing the tab', () => {
    noteExclusiveAccess(fakeContents() as never, 'pointerLock')
    expect(shown).toEqual([NOTICES.pointerLock])
  })

  it('shows nothing for a tab that is not on screen', () => {
    windows.showing = undefined
    noteExclusiveAccess(fakeContents() as never, 'pointerLock')
    expect(shown).toEqual([])
  })

  // Chromium asks for the keyboard lock again as the page enters
  // fullscreen, after the enter event: the fullscreen grant is where the
  // tab starts being watched, so that later ask sees it in fullscreen.
  it('knows a tab is in fullscreen from its own enter and leave events, watched from the fullscreen grant', () => {
    const contents = fakeContents()
    noteExclusiveAccess(contents as never, 'keyboardLock')
    expect(shown).toEqual([])

    noteExclusiveAccess(contents as never, 'fullscreen')
    contents.emit('enter-html-full-screen')
    noteExclusiveAccess(contents as never, 'keyboardLock')
    noteExclusiveAccess(contents as never, 'pointerLock')
    expect(shown).toEqual([NOTICES.holdEscToExitFullscreen])

    contents.emit('leave-html-full-screen')
    noteExclusiveAccess(contents as never, 'keyboardLock')
    noteExclusiveAccess(contents as never, 'pointerLock')
    expect(shown).toEqual([NOTICES.holdEscToExitFullscreen, NOTICES.pointerLock])
  })

  it('watches a tab once, however often it enters fullscreen', () => {
    const contents = fakeContents()
    noteExclusiveAccess(contents as never, 'fullscreen')
    noteExclusiveAccess(contents as never, 'fullscreen')
    expect(contents.listenerCount('enter-html-full-screen')).toBe(1)
    expect(contents.listenerCount('leave-html-full-screen')).toBe(1)
  })

  it('shows no notice for fullscreen itself: window.ts shows that one', () => {
    noteExclusiveAccess(fakeContents() as never, 'fullscreen')
    expect(shown).toEqual([])
  })
})
