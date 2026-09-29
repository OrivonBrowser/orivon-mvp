import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { clearInvocation, recordInvocation } from './extension-tab-invocation.js'

/** Tabs a (extensionId, tab) pair already has its clear-on-navigate/
 * clear-on-close listeners attached for -- recordTabCaptureInvocation runs
 * on every toolbar click, and a person can click the same extension's
 * action on the same tab many times over a long-lived tab's life; without
 * this, each click would add another pair of listeners that never comes
 * off, an unbounded leak on that WebContents. recordInvocation/
 * clearInvocation are themselves idempotent Set operations, so only the
 * listener wiring needs the guard. */
const wiredInvocations = new WeakMap<WebContents, Set<string>>()

/** browser-action.ts's activateClick calls this on every toolbar click --
 * extension-tab-invocation.ts's own ledger says why this exists at all
 * (Chrome's tabCapture rule). Cleared the moment the tab navigates to a
 * different origin or is closed, mirroring activeTab's own real lifetime;
 * `tab.getURL()` at grant time is the origin measured against, not the
 * origin the CLICK happened on, since both are the same thing here (the
 * click always happens on the tab as it exists right now). */
export function recordTabCaptureInvocation (extensionId: string, tab: WebContents): void {
  recordInvocation(extensionId, tab.id)

  const wired = wiredInvocations.get(tab) ?? new Set<string>()
  wiredInvocations.set(tab, wired)
  if (wired.has(extensionId)) return
  wired.add(extensionId)

  const grantedOrigin = originFromUrl(tab.getURL())
  const clear = (): void => { clearInvocation(extensionId, tab.id) }
  const onNavigate = (): void => {
    if (tab.isDestroyed() || originFromUrl(tab.getURL()) === grantedOrigin) return
    clear()
    tab.removeListener('destroyed', clear)
    tab.removeListener('did-navigate', onNavigate)
    wired.delete(extensionId)
  }
  tab.once('destroyed', clear)
  tab.on('did-navigate', onNavigate)
}
