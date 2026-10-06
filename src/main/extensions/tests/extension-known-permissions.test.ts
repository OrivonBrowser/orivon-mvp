import { describe, expect, it } from 'vitest'
import { filterExtensionLoadWarning, IMPLEMENTED_EXTENSION_PERMISSIONS } from '../extension-known-permissions.js'

describe('filterExtensionLoadWarning', () => {
  it('drops a permission line naming an implemented permission', () => {
    const message = "Warnings loading extension at /path:\n  Permission 'contextMenus' is unknown."
    expect(filterExtensionLoadWarning(message)).toBeUndefined()
  })

  it('keeps a permission line naming a permission this app does not implement', () => {
    const message = "Warnings loading extension at /path:\n  Permission 'fontSettings' is unknown."
    expect(filterExtensionLoadWarning(message)).toBe(message)
  })

  it('keeps the implemented-permission warning message unrelated to permissions untouched', () => {
    const message = 'Warnings loading extension at /path:\n  Something else entirely.'
    expect(filterExtensionLoadWarning(message)).toBe(message)
  })

  it('drops only the implemented line when a warning names both an implemented and an unimplemented permission', () => {
    const message = [
      'Warnings loading extension at /path:',
      "  Permission 'fontSettings' is unknown.",
      "  Permission 'contextMenus' is unknown.",
    ].join('\n')
    expect(filterExtensionLoadWarning(message)).toBe(
      "Warnings loading extension at /path:\n  Permission 'fontSettings' is unknown.",
    )
  })

  it('drops every permission line, and the message with them, when all name implemented permissions', () => {
    const message = [
      'Warnings loading extension at /path:',
      "  Permission 'cookies' is unknown.",
      "  Permission 'notifications' is unknown.",
      "  Permission 'webNavigation' is unknown.",
    ].join('\n')
    expect(filterExtensionLoadWarning(message)).toBeUndefined()
  })

  it('IMPLEMENTED_EXTENSION_PERMISSIONS lists the permissions this app actually serves today', () => {
    expect(IMPLEMENTED_EXTENSION_PERMISSIONS).toEqual(
      expect.arrayContaining(['contextMenus', 'cookies', 'notifications', 'offscreen', 'sidePanel', 'tabCapture', 'webNavigation']),
    )
  })
})
