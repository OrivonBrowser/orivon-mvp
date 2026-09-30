// What the address bar asks of main while someone types (`omnibox.*` chrome actions), and what choosing a row
// does to the window. Every payload comes from a renderer: text is bounded and every address that is opened is
// one the service holds, reached by an index.
import { aliasToInternal, viewSourceTarget } from '../pages/internal-aliases.js'
import { parseInternalUrl } from '../pages/internal-pages.js'
import { openViewSource } from '../page-tools/view-source.js'
import type { ChromeAction } from '../shell/chrome-actions.js'
import { sendChromeEvent } from '../shell/shell-events.js'
import type { WindowContext } from '../shell/window-context.js'
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { OMNIBOX_MODULE, OMNIBOX_OVERLAY } from './omnibox-names.js'
import { existingOmnibox, omniboxFor } from './omnibox-window.js'
import type { Disposition, Outcome } from './omnibox-service.js'

/** The longest text the bar is asked about: longer is not an address a person typed. */
export const MAX_QUERY_LENGTH = 2048

const DISPOSITIONS: readonly Disposition[] = ['current', 'tab', 'background']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 64
const isSeq = (value: unknown): value is number | undefined => value === undefined || (typeof value === 'number' && Number.isInteger(value))

export function isDisposition (value: unknown): value is Disposition {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value)
}

function rectOf (value: unknown): { x: number, y: number, width: number, height: number } | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height } = value
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : undefined
}

/** `{ text, typing, anchor }`: the rows for the text, shown under the address bar or hidden when there are none.
 * Answers how many rows there are and what the text may be finished with. */
export const omniboxQuery: ChromeAction = (payload, ctx) => {
  if (!isRecord(payload) || typeof payload['text'] !== 'string' || payload['text'].length > MAX_QUERY_LENGTH) return undefined
  const anchor = rectOf(payload['anchor'])
  if (anchor === undefined) return undefined
  const service = omniboxFor(ctx)
  const reply = service.query(payload['text'], payload['typing'] === true)
  const { overlays } = ctx.window
  if (reply.count === 0) overlays.close(OMNIBOX_OVERLAY)
  else if (overlays.isOpen(OMNIBOX_OVERLAY)) overlays.send(OMNIBOX_OVERLAY, { type: 'rows', ...service.snapshot() })
  else overlays.show(OMNIBOX_OVERLAY, anchor)
  return reply
}

/** `{ step: 1 | -1, seq? }`: moves the selection; answers the row and what the bar shows for it. */
export const omniboxSelect: ChromeAction = (payload, ctx) => {
  if (!isRecord(payload) || (payload['step'] !== 1 && payload['step'] !== -1) || !isSeq(payload['seq'])) return undefined
  const service = existingOmnibox(ctx.window)
  const moved = service?.select(payload['step'], payload['seq'])
  if (service === undefined || moved === undefined) return undefined
  ctx.window.overlays.send(OMNIBOX_OVERLAY, { type: 'rows', ...service.snapshot() })
  return moved
}

/** `{ index, disposition, seq? }`: does what choosing that row does. */
export const omniboxPick: ChromeAction = (payload, ctx) => {
  if (!isRecord(payload) || !isIndex(payload['index']) || !isDisposition(payload['disposition']) || !isSeq(payload['seq'])) return undefined
  return pickRow(ctx, payload['index'], payload['disposition'], payload['seq'])
}

/** `{ typed? }`: hides the rows. `typed` is what was submitted, to count as typed when it is an address. */
export const omniboxClose: ChromeAction = (payload, ctx) => {
  existingOmnibox(ctx.window)?.reset()
  ctx.window.overlays.close(OMNIBOX_OVERLAY)
  const typed = isRecord(payload) ? payload['typed'] : undefined
  if (typeof typed === 'string' && typed.length <= MAX_QUERY_LENGTH) {
    const result = parseOmniboxInput(typed)
    if (result.kind === 'url') ctx.services.history.markTyped(result.url)
  }
  return undefined
}

/** Runs the choice of row `index` of the window's rows. Shared by the chrome (keys) and the overlay (mouse). */
export function pickRow (ctx: WindowContext, index: number, disposition: Disposition, seq: number | undefined): boolean {
  const service = existingOmnibox(ctx.window)
  const outcome = service?.pick(index, disposition, seq)
  if (service === undefined || outcome === undefined) return false
  service.reset()
  ctx.window.overlays.close(OMNIBOX_OVERLAY)
  perform(ctx, outcome)
  // The address bar is done being typed in: it shows the page the choice leads to.
  sendChromeEvent(ctx.window, OMNIBOX_MODULE, { type: 'done' })
  return true
}

function perform (ctx: WindowContext, outcome: Outcome): void {
  const { window, services } = ctx
  if (outcome.type === 'switch') {
    switchToTab(ctx, outcome.tabId)
    return
  }
  if (outcome.markTyped !== null) services.history.markTyped(outcome.markTyped)
  const { tabs } = window
  const internal = aliasToInternal(outcome.target) ?? parseInternalUrl(outcome.target)
  const source = viewSourceTarget(outcome.target)
  if (outcome.disposition === 'current') {
    const active = tabs.getState().activeTabId
    if (active !== null) tabs.navigate(active, outcome.target)
  } else if (internal !== null) {
    tabs.openInternal(internal.page, internal.path)
  } else if (source !== null) {
    openViewSource(tabs, source)
  } else {
    tabs.createTab(outcome.target, outcome.disposition === 'tab')
  }
}

/** Activates the tab, in its own window, and leaves behind no empty new tab the choice was made from. */
function switchToTab (ctx: WindowContext, tabId: string): void {
  const { window, services } = ctx
  const owner = services.windows.all().find((entry) => !entry.window.isDestroyed() && entry.tabs.ids().includes(tabId))
  if (owner === undefined) return
  const { tabs: here, activeTabId } = window.tabs.getState()
  const leaving = here.find((tab) => tab.id === activeTabId && tab.isNewTab && !(owner === window && tab.id === tabId))
  owner.tabs.activateTab(tabId)
  if (owner !== window) {
    owner.window.show()
    owner.window.focus()
  }
  owner.tabs.activeWebContents()?.focus()
  if (leaving !== undefined) window.tabs.closeTab(leaving.id)
}
