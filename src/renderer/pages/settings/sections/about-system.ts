import type { Row } from '../model.js'
import { renderDefaultBrowser, renderRelease } from './default-browser-row.js'

/** Rows spread into the section they belong to, so a feature adds its rows here and edits no other file. */
export const aboutSystemRows: readonly Row[] = [
  {
    id: 'updates-release',
    label: 'Latest release',
    keywords: ['update', 'upgrade', 'release', 'download', 'new version', 'available'],
    control: { type: 'custom', wide: true, render: renderRelease },
    visible: (state) => state.updates.available() !== null
  },
  {
    id: 'default-browser',
    label: 'Default browser',
    help: 'Links you click in other programs open in Orivon.',
    keywords: ['default', 'browser', 'links', 'open links', 'http', 'https', 'web', 'system', 'make default', 'set default'],
    control: { type: 'custom', render: renderDefaultBrowser },
    visible: (state) => state.profiles?.isPrivate !== true
  }
]
