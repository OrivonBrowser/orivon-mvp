import type { Row } from '../model.js'
import { renderLocalFiles } from '../local-files/local-files-view.js'
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
  },
  {
    id: 'local-files',
    label: 'Files on this computer',
    help: 'Files you let use Orivon permissions. Deleting one removes what it may do, the files it saved, and its stored data; the file itself is not touched.',
    keywords: ['local files', 'file', 'html', 'computer', 'permissions', 'delete', 'saved data'],
    control: { type: 'custom', wide: true, render: renderLocalFiles }
  },
  {
    id: 'local-files-shared',
    label: 'Data kept by other local files',
    help: 'Files you have not allowed to use Orivon permissions share one place for what their pages store. This clears it for all of them.',
    keywords: ['local files', 'file', 'storage', 'indexeddb', 'clear', 'delete'],
    control: { type: 'action', label: 'Clear', confirm: 'Click again to clear', danger: true, run: async (state) => { await state.request('localFileData', { type: 'clearShared' }) } }
  }
]
