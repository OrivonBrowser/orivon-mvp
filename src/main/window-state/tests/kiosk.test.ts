import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../shortcuts/commands.js'
import { KIOSK_FLAG, kioskAllows } from '../kiosk.js'

describe('kioskAllows', () => {
  it('names the switch', () => {
    expect(KIOSK_FLAG).toBe('--orivon-kiosk')
  })

  it('runs only the page commands and quit', () => {
    const allowed = COMMANDS.map((command) => command.id).filter((id) => kioskAllows(id))
    expect([...allowed].sort()).toEqual([
      'nav.back', 'nav.forward', 'nav.reload', 'nav.hardReload',
      'zoom.in', 'zoom.out', 'zoom.reset',
      'find.open', 'find.next', 'find.previous',
      'page.print',
      'app.quit'
    ].sort())
  })

  it('refuses everything that leaves the page', () => {
    for (const id of ['tab.new', 'tab.close', 'window.new', 'window.newPrivate', 'window.close', 'window.fullscreen', 'settings.open', 'profiles.open', 'nav.home', 'nav.focusAddress', 'devtools.toggle', 'tab.moveToNewWindow'] as const) {
      expect(kioskAllows(id), id).toBe(false)
    }
  })
})
