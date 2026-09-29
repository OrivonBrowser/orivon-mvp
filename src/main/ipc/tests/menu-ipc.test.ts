import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { MENU_COMMAND_CHANNEL } from '../../channels.js'
import type { MenuItemView } from '../../shell/menu-layout.js'
import { registerMenuIpc } from '../menu-ipc.js'

const MENU_URL = 'app://orivon/menu/index.html'
const MENU_FRAME = { url: MENU_URL }
const OTHER_FRAME = { url: MENU_URL }
const LISTED: MenuItemView[] = [
  { kind: 'command', id: 'settings.open', label: 'Open Settings', keys: ['Ctrl', ','] },
  { kind: 'separator' }
]

function setup (): { call: (command: unknown, frame?: unknown) => unknown, run: ReturnType<typeof vi.fn>, height: ReturnType<typeof vi.fn> } {
  let handler: ((event: unknown, command: unknown) => unknown) | undefined
  const menu = { mainFrame: MENU_FRAME, ipc: { handle: (_channel: string, fn: typeof handler) => { handler = fn } } } as unknown as WebContents
  const run = vi.fn()
  const height = vi.fn()
  registerMenuIpc(menu, MENU_URL, { items: () => LISTED, run }, height)
  return { call: (command, frame = MENU_FRAME) => handler?.({ senderFrame: frame }, command), run, height }
}

describe('the main menu channel', () => {
  it('uses its own channel name', () => {
    expect(MENU_COMMAND_CHANNEL).toBe('orivon-menu:command')
  })

  it('answers the list, runs a listed command, and takes the content height', () => {
    const { call, run, height } = setup()
    expect(call({ type: 'items' })).toEqual(LISTED)
    call({ type: 'run', id: 'settings.open' })
    call({ type: 'contentHeight', height: 132 })
    expect(run).toHaveBeenCalledWith('settings.open')
    expect(height).toHaveBeenCalledWith(132)
  })

  it('refuses a command the menu does not list, one that does not exist, and a height that is not a number', () => {
    const { call, run, height } = setup()
    call({ type: 'run', id: 'app.quit' })
    call({ type: 'run', id: 'no.such.command' })
    call({ type: 'run', id: { toString: () => 'settings.open' } })
    call({ type: 'contentHeight', height: Number.NaN })
    expect(run).not.toHaveBeenCalled()
    expect(height).not.toHaveBeenCalled()
  })

  it('answers nothing to a frame that is not the menu\'s own', () => {
    const { call, run } = setup()
    expect(call({ type: 'items' }, OTHER_FRAME)).toBeUndefined()
    call({ type: 'run', id: 'settings.open' }, OTHER_FRAME)
    expect(run).not.toHaveBeenCalled()
  })

  // A269: identity alone lets a `senderFrame` reference kept past a
  // navigation Electron re-points elsewhere still pass -- the SAME frame
  // object, but committed at a URL that is no longer the menu's own.
  it('answers nothing once the menu\'s own frame reference has committed a URL that is no longer its own', () => {
    const { call, run } = setup()
    const originalUrl = MENU_FRAME.url
    MENU_FRAME.url = 'https://attacker.example/'

    try {
      expect(call({ type: 'items' })).toBeUndefined()
      call({ type: 'run', id: 'settings.open' })
      expect(run).not.toHaveBeenCalled()
    } finally {
      MENU_FRAME.url = originalUrl
    }
  })
})
