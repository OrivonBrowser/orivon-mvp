// The groups a tab's right-click menu is made of, one function each. A group
// answers only for what was clicked; context-menu.ts lays them in order. An
// action the caller did not supply is an item that is not offered, which is how
// the chrome's own menu stays small. Pure: no Electron value is used.
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import type { CommandId } from '../shortcuts/commands.js'
import { menuSafe, queryFrom, searchLabel } from './context-menu-text.js'

export interface ContextMenuActions {
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
  copyText: (text: string) => void
  /** Absent in a kiosk, which opens nothing beside the page it shows. */
  openInNewTab?: (url: string) => void
  /** Absent where a split is not offered. */
  openInSplit?: (url: string) => void
  openInWindow?: (url: string) => void
  /** Absent in a private window: that process has no way back to the profile. */
  openInPrivate?: (url: string) => void
  /** Saves an http(s) address to disk. */
  saveUrl?: (url: string) => void
  /** Searches the web for a selection, in a tab in front. */
  search?: (query: string) => void
  navigate?: { canGoBack: boolean, canGoForward: boolean, back: () => void, forward: () => void, reload: () => void }
  /** Runs a command on the window, as a key would. */
  run?: (id: CommandId) => void
  /** Toggles Picture in Picture for the video at a point of the page: the one clicked, not the page's main video. */
  pipAt?: (x: number, y: number) => void
  replaceMisspelling?: (word: string) => void
  addToDictionary?: (word: string) => void
  toggleSpellcheck?: () => void
  undo?: () => void
  redo?: () => void
  pasteAndMatchStyle?: () => void
  pasteAndGo?: () => void
  /** The address bar's "Always Show Full Addresses". */
  toggleFullAddresses?: () => void
  copyImageAt: (x: number, y: number) => void
  inspectAt: (x: number, y: number) => void
}

export type MenuParams = Pick<ContextMenuParams, 'x' | 'y' | 'linkURL' | 'linkText' | 'srcURL' | 'mediaType' | 'hasImageContents' | 'isEditable' | 'selectionText' | 'editFlags'> &
  Partial<Pick<ContextMenuParams, 'mediaFlags' | 'misspelledWord' | 'dictionarySuggestions'>>

/** What the menu needs to know that the click does not say. */
export interface ContextMenuContext {
  /** The engine a selection is searched with, as its menu wording. */
  engineLabel: string
  /** An internal page or the new-tab page: nothing to save, print or view as source. */
  bare: boolean
  /** The page's source can be shown: a web page, not an app's own tab. */
  viewSource: boolean
  spellcheckOn: boolean
  /** `addressBar.showFullUrl`, for the tick on the address bar's menu. */
  fullAddresses: boolean
}

export const DEFAULT_CONTEXT: ContextMenuContext = { engineLabel: 'the Web', bare: false, viewSource: true, spellcheckOn: true, fullAddresses: false }

const MAX_SUGGESTIONS = 5
const SEPARATOR: MenuItemConstructorOptions = { type: 'separator' }

/** An address a file can be fetched from: the one a new tab could load, and only http(s). */
function webAddress (url: string): string | null {
  const address = sanitizeDirectUrl(url)
  return address !== null && /^https?:\/\//i.test(address) ? address : null
}

export function spellingGroup (params: MenuParams, actions: ContextMenuActions, context: ContextMenuContext): MenuItemConstructorOptions[] {
  const word = params.misspelledWord ?? ''
  const replace = actions.replaceMisspelling
  if (!params.isEditable || !context.spellcheckOn || word === '' || replace === undefined) return []
  const suggestions = (params.dictionarySuggestions ?? []).slice(0, MAX_SUGGESTIONS)
    .filter((suggestion) => menuSafe(suggestion) !== '')
  const items: MenuItemConstructorOptions[] = suggestions.length === 0
    ? [{ label: 'No Spelling Suggestions', enabled: false }]
    : suggestions.map((suggestion) => ({ label: menuSafe(suggestion), click: () => { replace(suggestion) } }))
  const add = actions.addToDictionary
  if (add !== undefined) items.push(SEPARATOR, { label: 'Add to Dictionary', click: () => { add(word) } })
  return items
}

export function linkGroup (params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  if (params.linkURL === '') return []
  const items: MenuItemConstructorOptions[] = []
  // Only what a fresh tab can load: the same check window.open targets get.
  const openable = sanitizeDirectUrl(params.linkURL)
  if (openable !== null) {
    const inTab = actions.openInNewTab
    if (inTab !== undefined) items.push({ label: 'Open Link in New Tab', click: () => { inTab(openable) } })
    const inWindow = actions.openInWindow
    if (inWindow !== undefined) items.push({ label: 'Open Link in New Window', click: () => { inWindow(openable) } })
    const inPrivate = actions.openInPrivate
    if (inPrivate !== undefined) items.push({ label: 'Open Link in Private Window', click: () => { inPrivate(openable) } })
    const inSplit = actions.openInSplit
    if (inSplit !== undefined) items.push({ label: 'Open Link in Split View', click: () => { inSplit(openable) } })
  }
  const save = actions.saveUrl
  const saveable = webAddress(params.linkURL)
  if (save !== undefined && saveable !== null) items.push(SEPARATOR, { label: 'Save Link As…', click: () => { save(saveable) } })
  items.push({ label: 'Copy Link Address', click: () => { actions.copyText(params.linkURL) } })
  if (params.linkText.trim() !== '') items.push({ label: 'Copy Link Text', click: () => { actions.copyText(params.linkText.trim()) } })
  return items
}

export function imageGroup (params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  if (params.mediaType !== 'image') return []
  const items: MenuItemConstructorOptions[] = []
  const address = webAddress(params.srcURL)
  const inTab = actions.openInNewTab
  if (address !== null && inTab !== undefined) items.push({ label: 'Open Image in New Tab', click: () => { inTab(address) } })
  const save = actions.saveUrl
  if (address !== null && save !== undefined) items.push({ label: 'Save Image As…', click: () => { save(address) } })
  if (params.hasImageContents) items.push({ label: 'Copy Image', click: () => { actions.copyImageAt(params.x, params.y) } })
  if (address !== null) items.push({ label: 'Copy Image Address', click: () => { actions.copyText(address) } })
  return items
}

export function mediaGroup (params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  if (params.mediaType !== 'video' && params.mediaType !== 'audio') return []
  const noun = params.mediaType === 'video' ? 'Video' : 'Audio'
  const items: MenuItemConstructorOptions[] = []
  const run = actions.run
  if (params.mediaType === 'video' && params.mediaFlags?.canShowPictureInPicture === true && run !== undefined) {
    const at = actions.pipAt
    items.push({ label: 'Picture in Picture', type: 'checkbox', checked: params.mediaFlags.isShowingPictureInPicture, click: () => { if (at === undefined) run('page.pip'); else at(params.x, params.y) } })
  }
  const address = webAddress(params.srcURL)
  if (address === null) return items
  const inTab = actions.openInNewTab
  if (inTab !== undefined) items.push({ label: `Open ${noun} in New Tab`, click: () => { inTab(address) } })
  const save = actions.saveUrl
  if (save !== undefined) items.push({ label: `Save ${noun} As…`, click: () => { save(address) } })
  items.push({ label: `Copy ${noun} Address`, click: () => { actions.copyText(address) } })
  return items
}

export function selectionGroup (params: MenuParams, actions: ContextMenuActions, context: ContextMenuContext): MenuItemConstructorOptions[] {
  const query = queryFrom(params.selectionText)
  if (params.isEditable || query === '') return []
  const items: MenuItemConstructorOptions[] = [{ label: 'Copy', enabled: params.editFlags.canCopy, click: actions.copy }]
  const search = actions.search
  if (search !== undefined) items.push({ label: searchLabel(context.engineLabel, params.selectionText), click: () => { search(query) } })
  return items
}

export function editableGroup (params: MenuParams, actions: ContextMenuActions, context: ContextMenuContext): MenuItemConstructorOptions[] {
  if (!params.isEditable) return []
  const flags = params.editFlags
  const items: MenuItemConstructorOptions[] = []
  const { undo, redo, pasteAndMatchStyle, pasteAndGo, toggleSpellcheck, toggleFullAddresses } = actions
  if (undo !== undefined) items.push({ label: 'Undo', enabled: flags.canUndo, click: undo })
  if (redo !== undefined) items.push({ label: 'Redo', enabled: flags.canRedo, click: redo })
  if (items.length > 0) items.push(SEPARATOR)
  items.push(
    { label: 'Cut', enabled: flags.canCut, click: actions.cut },
    { label: 'Copy', enabled: flags.canCopy, click: actions.copy },
    { label: 'Paste', enabled: flags.canPaste, click: actions.paste }
  )
  if (pasteAndGo !== undefined) items.push({ label: 'Paste and Go', enabled: flags.canPaste, click: pasteAndGo })
  if (pasteAndMatchStyle !== undefined) items.push({ label: 'Paste as Plain Text', enabled: flags.canPaste, click: pasteAndMatchStyle })
  items.push(SEPARATOR, { label: 'Select All', enabled: flags.canSelectAll, click: actions.selectAll })
  if (toggleSpellcheck !== undefined) items.push(SEPARATOR, { label: 'Check Spelling', type: 'checkbox', checked: context.spellcheckOn, click: toggleSpellcheck })
  if (toggleFullAddresses !== undefined) items.push(SEPARATOR, { label: 'Always Show Full Addresses', type: 'checkbox', checked: context.fullAddresses, click: toggleFullAddresses })
  return items
}

export function pageGroup (actions: ContextMenuActions, context: ContextMenuContext): MenuItemConstructorOptions[] {
  const nav = actions.navigate
  if (nav === undefined) return []
  const items: MenuItemConstructorOptions[] = [
    { label: 'Back', enabled: nav.canGoBack, click: nav.back },
    { label: 'Forward', enabled: nav.canGoForward, click: nav.forward },
    { label: 'Reload', click: nav.reload }
  ]
  const run = actions.run
  if (context.bare || run === undefined) return items
  items.push(
    SEPARATOR,
    { label: 'Save Page As…', click: () => { run('page.save') } },
    { label: 'Print…', click: () => { run('page.print') } },
    { label: 'Take a Screenshot', click: () => { run('page.screenshot') } },
    { label: 'Create QR Code for This Page', click: () => { run('page.qr') } }
  )
  if (context.viewSource) items.push(SEPARATOR, { label: 'View Page Source', click: () => { run('page.viewSource') } })
  return items
}
