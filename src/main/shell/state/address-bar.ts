import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the address bar shows full addresses; it follows the setting live. */
export const addressBarStatePart: ShellStatePart = {
  name: 'addressBar',
  read: ({ services }) => ({ showFullUrl: services.settings.get('addressBar.showFullUrl') }),
  watch: ({ services }, push) => services.settings.onChange(({ key }) => { if (key === 'addressBar.showFullUrl') push() })
}
