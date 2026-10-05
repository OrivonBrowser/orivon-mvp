import type { Row } from '../model.js'
import { renderRelease } from './default-browser-row.js'

/** Rows spread into the section they belong to, so a feature adds its rows here and edits no other file. */
export const aboutSystemRows: readonly Row[] = [
  {
    id: 'updates-release',
    label: 'Latest release',
    keywords: ['update', 'upgrade', 'release', 'download', 'new version', 'available'],
    control: { type: 'custom', wide: true, render: renderRelease },
    visible: (state) => state.updates.available() !== null
  }
]
