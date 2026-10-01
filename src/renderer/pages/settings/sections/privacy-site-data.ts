import type { Row } from '../model.js'
import { dataStoredText, renderSiteData } from '../site-data/site-data-view.js'

/** Rows spread into the section they belong to, so a feature adds its rows here and edits no other file. */
export const privacySiteDataRows: readonly Row[] = [
  {
    id: 'site-data-total',
    label: 'Data stored by sites',
    help: 'Cookies, what sites keep in this browser, and the files kept to load pages faster. An estimate: some storage cannot be measured.',
    keywords: ['storage', 'disk', 'space', 'size', 'cache', 'usage', 'cookies', 'megabytes'],
    control: { type: 'info', text: dataStoredText }
  },
  {
    id: 'site-data',
    label: 'Sites that store data',
    help: 'Found from the cookies sites keep and the databases they write, so the list is approximate. Deleting a site signs you out of it. Cookie values are never shown.',
    keywords: ['cookies', 'site data', 'storage', 'delete', 'remove', 'sites', 'indexeddb', 'local storage', 'sign out'],
    control: { type: 'custom', wide: true, render: renderSiteData }
  }
]
