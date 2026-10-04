// "Put tab to sleep" from a command or a menu: the tab in front hands the window to a neighbour first, and a tab
// that must stay awake says why in a toast.
import type { ToastCode } from '../page-tools/toast.js'
import { showToast } from '../page-tools/toast.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { gatherFacts, realEnv } from './sleep-facts.js'
import type { SleepEnv } from './sleep-facts.js'
import { canSleep } from './sleep-rules.js'
import type { SleepVerdict, SleepWhy } from './sleep-rules.js'
import { sleepTabWhy } from './sleep-tab.js'

/** What each reason is told as. A reason the person need not hear about (the tab is gone) has none. */
export function toastFor (why: SleepWhy): ToastCode | null {
  switch (why) {
    case 'sound': return 'sleepSound'
    case 'unsaved': return 'sleepUnsaved'
    case 'pinned': return 'sleepPinned'
    case 'ask': return 'sleepAsk'
    case 'media': return 'sleepMedia'
    case 'kept': return 'sleepKept'
    case 'gone': return null
    default: return 'sleepOther'
  }
}

function tell (window: ShellWindow, verdict: SleepVerdict): void {
  if (verdict.ok) return
  const code = toastFor(verdict.why)
  if (code !== null) showToast(window, code)
}

/** The tab the window falls back to when `id` goes to sleep: the nearest one `hidden` does not hide, never the tab it is joined to. */
export function neighbourOf (ids: readonly string[], id: string, partner: string | null, hidden: (id: string) => boolean = () => false): string | undefined {
  const at = ids.indexOf(id)
  if (at === -1) return undefined
  const others = ids.map((other, position) => ({ other, distance: Math.abs(position - at), before: position < at, hidden: hidden(other) }))
    .filter(({ other }) => other !== id && other !== partner)
  others.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.distance - b.distance || Number(b.before) - Number(a.before))
  return others[0]?.other
}

/** Puts a tab in the background to sleep, or says why it stays awake. */
export async function sleepBackgroundTab (window: ShellWindow, id: string, env: SleepEnv = realEnv): Promise<void> {
  tell(window, await sleepTabWhy(window.tabs, id, env))
}

/** Puts the tab in front to sleep: the window moves to the neighbour first, but only once nothing keeps this tab
 * awake, so a refused tab is never left. */
export async function sleepFrontTab (window: ShellWindow, id: string, env: SleepEnv = realEnv): Promise<void> {
  const { tabs } = window
  const wc = tabs.liveWebContents(id)
  const partner = tabs.splits.groups.partnerOf(id)
  const next = neighbourOf(tabs.ids(), id, partner, tabs.hidden)
  const facts = gatherFacts(tabs, id, env)
  if (wc === undefined || facts === null) return
  // As if it were already behind: what is left to ask is whether its own page may go.
  const early = canSleep({ ...facts, active: false, splitPartner: false, unsaved: await env.unsaved(wc) })
  if (!early.ok) { tell(window, early); return }
  if (next === undefined) { tell(window, { ok: false, why: 'active' }); return }
  tabs.activateTab(next)
  const verdict = await sleepTabWhy(tabs, id, env)
  if (!verdict.ok) {
    // Something changed in the moment between: the person stays where they were.
    if (tabs.record(id) !== undefined) tabs.activateTab(id)
    tell(window, verdict)
  }
}
