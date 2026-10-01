// What the sidebar draws beside each section: its icon, and which of the three
// muted groups it falls under. Kept here, apart from main.ts's rendering and
// sections/index.ts's ordering, so a new section only has to be added to one
// list of icons and one map of groups, not worked into the drawing code.
import { appearanceIcon, appsIcon, developerIcon, downloadIcon, fileIcon, homeIcon, infoIcon, keyboardIcon, privacyIcon, profilesIcon, searchGlassIcon, tabsIcon, webIcon } from '../shared/icons.js'
import type { Section } from './model.js'

export const NAV_ICON: Readonly<Record<string, () => SVGSVGElement>> = {
  appearance: appearanceIcon,
  search: searchGlassIcon,
  startup: homeIcon,
  content: fileIcon,
  tabs: tabsIcon,
  downloads: downloadIcon,
  profiles: profilesIcon,
  privacy: privacyIcon,
  apps: appsIcon,
  web3: webIcon,
  shortcuts: keyboardIcon,
  developer: developerIcon,
  about: infoIcon
}

/** Three groups over the thirteen sections: what you are browsing with, who and what
 * may act on your behalf, and everything past everyday use. Relies on
 * sections/index.ts keeping its sections in this order -- a section moved out
 * of its neighbours here would read as belonging to the wrong group. */
const NAV_GROUP: Readonly<Record<string, string>> = {
  appearance: 'Browsing',
  search: 'Browsing',
  startup: 'Browsing',
  content: 'Browsing',
  tabs: 'Browsing',
  downloads: 'Browsing',
  profiles: 'Privacy and accounts',
  privacy: 'Privacy and accounts',
  apps: 'Privacy and accounts',
  web3: 'Privacy and accounts',
  shortcuts: 'Advanced',
  developer: 'Advanced',
  about: 'Advanced'
}

/** The group heading to draw above `section`, or null when it shares its group with the one before it. */
export function groupLabelFor (section: Section, previous: Section | undefined): string | null {
  const group = NAV_GROUP[section.id]
  if (group === undefined) return null
  const previousGroup = previous === undefined ? undefined : NAV_GROUP[previous.id]
  return group === previousGroup ? null : group
}
