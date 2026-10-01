// The names other browsers use for pages Orivon has too (`about:version`,
// `chrome://gpu`, `chrome://downloads`), so typing one lands on the page of the
// same purpose. Pure: no Electron, no Node. Only the address bar calls it; a
// link, a popup or an external open never does, and `about:` stays refused for
// everything this does not claim.
import { isInternalPageId } from './internal-pages.js'
import type { InternalPageId } from './internal-pages.js'

export interface InternalAlias {
  readonly page: InternalPageId
  readonly path: string
}

/** Names that are not a page's own: another browser's word for one of ours. */
const RENAMED: Readonly<Record<string, InternalAlias>> = {
  version: { page: 'about', path: '/' },
  about: { page: 'about', path: '/' },
  gpu: { page: 'about', path: '/gpu' },
  'task-manager': { page: 'tasks', path: '/' }
}

const PATH = /^(\/[a-z0-9_-]+)*\/?$/

/** Reads `about:<name>` and `chrome://<name>[/path]`, in any capitals. Null for anything else: a query or
 * fragment, `about:blank`, a name Orivon has no page for, and the private window's page, which is reached
 * by opening a private window, not by an address. */
export function aliasToInternal (input: string): InternalAlias | null {
  const text = input.trim().toLowerCase()
  let name: string
  let path: string
  if (text.startsWith('about:') && !text.startsWith('about://')) {
    name = text.slice('about:'.length)
    path = ''
  } else if (text.startsWith('chrome://')) {
    const rest = text.slice('chrome://'.length)
    const slash = rest.indexOf('/')
    name = slash === -1 ? rest : rest.slice(0, slash)
    path = slash === -1 ? '' : rest.slice(slash)
  } else {
    return null
  }
  if (!/^[a-z0-9-]+$/.test(name) || !PATH.test(path)) return null
  const renamed = RENAMED[name]
  if (renamed !== undefined) return path === '' || path === '/' ? renamed : null
  if (name === 'private' || !isInternalPageId(name)) return null
  return { page: name, path: path === '' ? '/' : path }
}

/** The address after a typed `view-source:`, when it is an http or https one; otherwise null. */
export function viewSourceTarget (input: string): string | null {
  const text = input.trim()
  if (!/^view-source:/i.test(text)) return null
  const inner = text.slice('view-source:'.length).trim()
  return /^https?:\/\//i.test(inner) ? inner : null
}
