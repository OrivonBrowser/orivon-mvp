import type { Bookmark } from '../../main/browsing/bookmarks.js'
import { closeIcon, faviconElement, path, svg } from '../icons.js'
import { FEATURED, iconUrl } from './featured.js'
import { readStartHere, stepText } from './start-here-model.js'
import { readYourApps, yourAppsView, type YourAppTile } from './your-apps-model.js'
import { featuredRow, NO_PREFS, readPrefs, type FeaturedPrefs, type FeaturedTile } from './featured-model.js'

// The dashboard's whole job: a search box, the featured apps and real bookmark tiles -- see
// index.html's own header for the scope note.

interface OrivonNewTab {
  getBookmarks: () => Promise<Bookmark[]>
  navigate: (input: string) => void
  getFeatured: () => Promise<unknown>
  getYourApps: () => Promise<unknown>
  hideFeatured: (id: string) => Promise<unknown>
  unpinFeatured: (id: string) => Promise<unknown>
  showHiddenFeatured: () => Promise<unknown>
  getStartHere: () => Promise<unknown>
  dismissStartHere: () => Promise<unknown>
}

declare global {
  interface Window {
    orivonNewTab?: OrivonNewTab
  }
}

// Deliberately NOT a hard throw (unlike the chrome view's own `must()`
// pattern in ../main.ts). The chrome view NEVER loads without its
// preload; this page legitimately can -- src/main/tabs.ts only chooses
// the privileged preload for a genuinely fresh tab (`url === undefined`),
// so this exact page loaded any other way (e.g. a stray reference to its
// own dev-mode URL) gets the ordinary, unprivileged preload instead. That
// is a safe, expected case, not a bug -- degrade gracefully rather than
// crash the page over it.
const shell = window.orivonNewTab

const searchForm = document.querySelector<HTMLFormElement>('#search-form')
const searchInput = document.querySelector<HTMLInputElement>('#search-input')
const bookmarksSection = document.querySelector<HTMLElement>('#bookmarks-section')
const bookmarksGrid = document.querySelector<HTMLDivElement>('#bookmarks-grid')
const featuredGrid = document.querySelector<HTMLDivElement>('#featured-grid')
const showHiddenButton = document.querySelector<HTMLButtonElement>('#featured-show-hidden')
const yourAppsSection = document.querySelector<HTMLElement>('#your-apps-section')
const yourAppsGrid = document.querySelector<HTMLDivElement>('#your-apps-grid')
const yourAppsEmpty = document.querySelector<HTMLElement>('#your-apps-empty')
const yourAppsManage = document.querySelector<HTMLButtonElement>('#your-apps-manage')

/** Set on the root element, and announced as an event on the document, once every row has been drawn. Main reads both by these literal names. */
const SETTLED_ATTRIBUTE = 'settled'
const SETTLED_EVENT = 'orivon-newtab-settled'

/** Where the grants of every app are listed and switched. */
const APP_PERMISSIONS_PAGE = 'orivon://settings/apps'

if (shell !== undefined) {
  searchInput?.focus()
  // A page that loads while a sheet or the address bar already has the keyboard never gets a blur to hear: it starts away.
  if (!document.hasFocus()) document.documentElement.dataset['away'] = '1'
  // While the address bar has the keyboard, this page's field is not the one being typed in, so it stops looking focused.
  window.addEventListener('blur', () => { document.documentElement.dataset['away'] = '1' })
  window.addEventListener('focus', () => { delete document.documentElement.dataset['away'] })

  searchForm?.addEventListener('submit', (e) => {
    e.preventDefault()
    const value = searchInput?.value.trim() ?? ''
    if (value.length > 0) shell.navigate(value)
  })

  // Every row that main fills in; the page says it is settled once each has answered, or failed to.
  const drawing: Array<Promise<unknown>> = []
  const startHere = document.querySelector<HTMLElement>('#start-here')
  if (startHere !== null) drawing.push(startStartHere(shell, startHere))

  if (featuredGrid !== null && showHiddenButton !== null) drawing.push(startFeatured(shell, featuredGrid, showHiddenButton))

  if (yourAppsSection !== null && yourAppsGrid !== null && yourAppsEmpty !== null && yourAppsManage !== null) {
    yourAppsManage.addEventListener('click', () => { shell.navigate(APP_PERMISSIONS_PAGE) })
    drawing.push(renderYourApps(shell, { section: yourAppsSection, grid: yourAppsGrid, empty: yourAppsEmpty }))
  }

  if (bookmarksSection !== null && bookmarksGrid !== null) {
    drawing.push(renderBookmarks(shell, bookmarksSection, bookmarksGrid))
  }

  // The welcome screen waits for this before it takes the picture it blurs behind its telemetry popup (src/main/shell/intro-view.ts).
  void Promise.allSettled(drawing).then(() => {
    document.documentElement.dataset[SETTLED_ATTRIBUTE] = '1'
    document.dispatchEvent(new CustomEvent(SETTLED_EVENT))
  })
}

/** The card is drawn once main has said this profile still has it to show, and never when main says no. */
async function startStartHere (shell: OrivonNewTab, card: HTMLElement): Promise<void> {
  const view = readStartHere(await shell.getStartHere().catch(() => null))
  const steps = card.querySelector<HTMLOListElement>('#start-here-steps')
  const dismiss = card.querySelector<HTMLButtonElement>('#start-here-dismiss')
  const note = card.querySelector<HTMLElement>('#start-here-ubo')
  if (view === null || steps === null || dismiss === null || note === null) return
  steps.replaceChildren(...view.steps.map(({ id, done }) => {
    const text = stepText(id, view)
    const item = document.createElement('li')
    item.className = 'start-step'
    item.dataset['step'] = id
    item.dataset['done'] = done ? '1' : '0'

    const mark = document.createElement('span')
    mark.className = 'step-mark'
    mark.setAttribute('aria-hidden', 'true')
    if (done) mark.append(checkIcon())

    const status = document.createElement('span')
    status.className = 'visually-hidden'
    status.textContent = done ? 'Done: ' : 'To do: '

    const title = document.createElement('span')
    title.className = 'step-title'
    title.textContent = text.title

    const body = document.createElement('div')
    body.className = 'step-body'
    const heading = document.createElement('div')
    heading.append(status, title)
    body.append(heading)
    if (text.detail !== null) {
      const detail = document.createElement('p')
      detail.className = 'step-detail'
      detail.textContent = text.detail
      body.append(detail)
    }
    const action = document.createElement('button')
    action.className = 'step-action'
    action.type = 'button'
    action.textContent = text.action
    action.addEventListener('click', () => { shell.navigate(text.target) })
    body.append(action)

    item.append(mark, body)
    return item
  }))
  note.hidden = !view.uboOn
  dismiss.addEventListener('click', () => {
    void shell.dismissStartHere().then(() => { card.hidden = true; searchInput?.focus() })
  })
  card.hidden = false
}

/** The row is drawn once main has said what this profile pinned and hid, so it never shows in the wrong order first. */
async function startFeatured (shell: OrivonNewTab, grid: HTMLDivElement, showHidden: HTMLButtonElement): Promise<void> {
  const draw = (prefs: FeaturedPrefs, focus?: { id: string } | { index: number }): void => {
    const { tiles, hiddenCount } = featuredRow(FEATURED, prefs)
    grid.replaceChildren(...tiles.map((tile) => featuredTile(tile, {
      open: () => { shell.navigate(tile.url) },
      hide: () => { void shell.hideFeatured(tile.id).then((answer) => { draw(readPrefs(answer), { index: tiles.findIndex((t) => t.id === tile.id) }) }) },
      unpin: () => { void shell.unpinFeatured(tile.id).then((answer) => { draw(readPrefs(answer), { id: tile.id }) }) }
    })))
    showHidden.hidden = hiddenCount === 0
    showHidden.textContent = `Show hidden (${hiddenCount})`
    showHidden.onclick = () => {
      void shell.showHiddenFeatured().then((answer) => { draw(readPrefs(answer)); searchInput?.focus() })
    }
    // A tile that was just hidden or moved leaves the keyboard on a control that is gone: it goes to the tile now at that place.
    const buttons = [...grid.querySelectorAll<HTMLButtonElement>('.tile')]
    if (focus === undefined) return
    const next = 'id' in focus ? buttons.find((button) => button.dataset['id'] === focus.id) : buttons[Math.min(focus.index, buttons.length - 1)]
    next?.focus()
  }
  draw(await shell.getFeatured().then(readPrefs, () => NO_PREFS))
}

/** The apps this profile has granted capabilities to. The row stays hidden until main has answered, so a private window never flashes it. */
async function renderYourApps (shell: OrivonNewTab, parts: { section: HTMLElement, grid: HTMLDivElement, empty: HTMLElement }): Promise<void> {
  const view = yourAppsView(await shell.getYourApps().then(readYourApps, () => readYourApps(undefined)))
  if (!view.shown) return
  parts.grid.replaceChildren(...view.tiles.map((app: YourAppTile) => tileFor(app.name, app.origin, faviconElement(app.icon), () => { shell.navigate(app.origin) })))
  parts.empty.hidden = view.empty === null
  parts.empty.textContent = view.empty
  parts.section.hidden = false
}

async function renderBookmarks (
  shell: OrivonNewTab,
  section: HTMLElement,
  grid: HTMLDivElement
): Promise<void> {
  const bookmarks = await shell.getBookmarks()
  if (bookmarks.length === 0) return

  for (const bookmark of bookmarks) {
    grid.append(tileFor(bookmark.title.length > 0 ? bookmark.title : bookmark.url, bookmark.url, faviconElement(bookmark.favicon), () => { shell.navigate(bookmark.url) }))
  }

  section.hidden = false
}

/** One tile, the same for a bookmark and a featured app: it opens `url` and shows `icon`. */
function tileFor (title: string, url: string, icon: Element, open: () => void): HTMLButtonElement {
  const tile = document.createElement('button')
  tile.className = 'tile'
  tile.type = 'button'
  tile.title = url

  icon.classList.add('tile-icon')

  const label = document.createElement('span')
  label.className = 'tile-label'
  label.textContent = title

  tile.append(icon, label)
  tile.addEventListener('click', open)
  return tile
}

/** A featured app's tile with its two small controls, which show on hover and on keyboard focus: Unpin (only on a pinned tile) and Hide. */
function featuredTile (tile: FeaturedTile, actions: { open: () => void, hide: () => void, unpin: () => void }): HTMLDivElement {
  const source = iconUrl(tile.icon)
  const icon = source === null ? letterIcon(tile.name) : faviconElement(source)
  const button = tileFor(tile.name, tile.url, icon, actions.open)
  button.dataset['id'] = tile.id

  const controls = document.createElement('div')
  controls.className = 'tile-actions'
  if (tile.pinned) controls.append(actionButton(`Unpin ${tile.name}`, pinIcon(), actions.unpin))
  controls.append(actionButton(`Hide ${tile.name}`, closeIcon(), actions.hide))

  const wrap = document.createElement('div')
  wrap.className = 'tile-wrap'
  wrap.append(button, controls)
  return wrap
}

function actionButton (name: string, icon: Element, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'tile-action'
  button.type = 'button'
  button.title = name
  button.setAttribute('aria-label', name)
  button.append(icon)
  button.addEventListener('click', run)
  return button
}

/** A neutral mark for an app with no icon of its own: the first letter of its name. */
function letterIcon (name: string): HTMLSpanElement {
  const mark = document.createElement('span')
  mark.className = 'tile-letter'
  mark.textContent = name.charAt(0).toUpperCase()
  mark.setAttribute('aria-hidden', 'true')
  return mark
}

/** Lucide's `check` (ISC licence, https://lucide.dev). */
function checkIcon (): SVGSVGElement {
  const icon = svg('0 0 24 24')
  icon.append(path('M20 6 9 17l-5-5', '3'))
  return icon
}

/** Lucide's `pin` (ISC licence, https://lucide.dev), as the other hand-drawn icons here are. */
function pinIcon (): SVGSVGElement {
  const icon = svg('0 0 24 24')
  icon.append(
    path('M12 17v5', '2'),
    path('M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z', '2')
  )
  return icon
}
