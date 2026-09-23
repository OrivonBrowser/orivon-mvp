// What each tab remembers between the questions a page can make the shell
// ask (open an external link, show notifications): whether one is on screen
// now, whether the person has touched the page since the last one, and
// whether this page load already had its notification question dismissed.
// Keyed weakly by the tab's webContents, so a closed tab takes its state
// with it. No electron import: a webContents is used only through `on`.

/** The events of a tab's webContents this reads, typed as Electron emits them. */
export interface PromptingTab {
  on: ((event: 'input-event', listener: (event: unknown, input: { type: string }) => void) => unknown) &
  ((event: 'did-navigate', listener: () => void) => unknown)
}

export interface TabPromptState {
  /** A question from this tab is on screen; another waits for none. */
  prompting: boolean
  /** The person clicked, tapped or pressed a key in the page since the
   * last question. True for a fresh tab, so its first ask needs nothing. */
  touched: boolean
  /** "Not now" was the answer during this page load. */
  notificationsDismissed: boolean
}

/** Input the person has to make on purpose. Pointer movement, scrolling and
 * key release are not: a page gets them without anyone meaning to act. */
const INTERACTIONS: ReadonlySet<string> = new Set(['mouseDown', 'pointerDown', 'touchStart', 'rawKeyDown', 'keyDown'])

const states = new WeakMap<PromptingTab, TabPromptState>()

export function tabPromptState (tab: PromptingTab): TabPromptState {
  const existing = states.get(tab)
  if (existing !== undefined) return existing
  const state: TabPromptState = { prompting: false, touched: true, notificationsDismissed: false }
  tab.on('input-event', (_event, input) => { if (INTERACTIONS.has(input.type)) state.touched = true })
  // Main frame only, and not for in-page (hash or history) navigations:
  // exactly a new page load.
  tab.on('did-navigate', () => { state.notificationsDismissed = false })
  states.set(tab, state)
  return state
}
