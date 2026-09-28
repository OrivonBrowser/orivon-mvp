// The sections in the order the page lists them. Each later feature adds its
// section here.
import type { Section } from '../model.js'
import type { SettingsState } from '../state.js'
import { about } from './about.js'
import { appearance } from './appearance.js'
import { search } from './search.js'
import { shortcutsSection } from './shortcuts.js'
import { tabs } from './tabs.js'

/** After the state has loaded: some sections are built from what main reports. */
export function sectionsFor (state: SettingsState): readonly Section[] {
  return [appearance, search, tabs, shortcutsSection(state.shortcuts.rows), about]
}
