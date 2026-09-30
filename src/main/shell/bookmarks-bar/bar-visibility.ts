// Reading and changing whether the bar is shown, for the window's layout, the menu tick and the toggle command.
import type { ShellServices } from '../shell-services.js'
import { barIsShown, toggledMode } from './bar-items.js'
import type { BarMode } from './bar-items.js'

type Parts = Pick<ShellServices, 'settings' | 'bookmarks'>

const modeOf = ({ settings }: Parts): BarMode => settings.get('appearance.bookmarksBar')

export function bookmarksBarShown (services: Parts): boolean {
  return barIsShown(modeOf(services), services.bookmarks.children('bar').length)
}

/** Mod+Shift+B: the setting flips between 'always' and 'never', so the Settings row and the key agree. */
export function toggleBookmarksBar (services: Parts): void {
  services.settings.set('appearance.bookmarksBar', toggledMode(modeOf(services), services.bookmarks.children('bar').length))
}
