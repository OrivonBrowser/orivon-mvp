// The sections in the order the page lists them. Each later feature adds its
// section here.
import type { Section } from '../model.js'
import type { SettingsState } from '../state.js'
import { about } from './about.js'
import { apps } from './apps.js'
import { appearance } from './appearance.js'
import { content } from './content.js'
import { developer } from './developer.js'
import { privacy } from './privacy.js'
import { profiles } from './profiles.js'
import { search } from './search.js'
import { shortcutsSection } from './shortcuts.js'
import { startup } from './startup.js'
import { tabs } from './tabs.js'
import { web3 } from './web3.js'

/** After the state has loaded: some sections are built from what main reports. */
export function sectionsFor (state: SettingsState): readonly Section[] {
  return [appearance, search, startup, content, tabs, profiles, privacy, apps, web3, shortcutsSection(state.shortcuts.rows), developer, about]
}
