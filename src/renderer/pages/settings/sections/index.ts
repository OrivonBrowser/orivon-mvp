// The sections in the order the page lists them. Each later feature adds its
// section here.
import type { Section } from '../model.js'
import type { SettingsState } from '../state.js'
import { about } from './about.js'
import { accessibility } from './accessibility.js'
import { addresses } from './addresses.js'
import { apps } from './apps.js'
import { appearance } from './appearance.js'
import { content } from './content.js'
import { defaultBrowserSection } from './default-browser.js'
import { developer } from './developer.js'
import { downloads } from './downloads.js'
import { performanceSection } from './performance.js'
import { passwords } from './passwords.js'
import { privacy } from './privacy.js'
import { profiles } from './profiles.js'
import { search } from './search.js'
import { shortcutsSection } from './shortcuts.js'
import { sitesSection } from './sites.js'
import { startup } from './startup.js'
import { tabs } from './tabs.js'
import { web3 } from './web3.js'

/** After the state has loaded: some sections are built from what main reports. A section with no rows is not listed. */
export function sectionsFor (state: SettingsState): readonly Section[] {
  return [appearance, search, defaultBrowserSection(state), startup, content, accessibility, tabs, downloads, profiles, privacy, sitesSection(state), passwords, addresses, apps, web3, performanceSection, shortcutsSection(state.shortcuts.rows), developer, about]
    .filter((section) => section.rows.length > 0)
}
