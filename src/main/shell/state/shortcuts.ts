import type { ShellStatePart } from '../shell-state-parts.js'

/** The bindings the chrome names in its tooltips, which follow the Shortcuts settings live. */
export const shortcutsStatePart: ShellStatePart = {
  name: 'shortcuts',
  read: ({ services }) => ({
    shortcutKeys: { 'nav.home': services.shortcuts.keysOf('nav.home'), 'page.reader': services.shortcuts.keysOf('page.reader'), 'tab.search': services.shortcuts.keysOf('tab.search') }
  }),
  watch: ({ services }, push) => services.shortcuts.onChange(push)
}
