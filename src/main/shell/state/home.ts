import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the toolbar shows the Home button; it follows the setting live. */
export const homeStatePart: ShellStatePart = {
  name: 'home',
  read: ({ services }) => ({ homeButton: services.settings.get('toolbar.home') }),
  watch: ({ services }, push) => services.settings.onChange(({ key }) => { if (key === 'toolbar.home') push() })
}
