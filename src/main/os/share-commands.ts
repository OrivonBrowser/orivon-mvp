// The `share.*` commands: copy the address of a tab, or start an email about it. `tabId` names the tab the tab's own
// menu was opened on; a command from a key or the main menu acts on the tab in front.
import { originFromUrl } from '../../broker/policy/origin.js'
import { showToast } from '../page-tools/toast.js'
import type { ExternalLinkQuestion } from '../sessions/external-links.js'
import type { QuestionTarget } from '../shell/question/ask-question.js'
import type { TabState } from '../shell/tab-types.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { mailtoFor, shareAddressFor } from './share.js'

export interface ShareDeps {
  writeClipboard: (text: string) => void
  /** The question the page-opened external links ask: true only when the person chose to go on. */
  confirm: (where: QuestionTarget, question: ExternalLinkQuestion) => Promise<boolean>
  openExternal: (url: string) => Promise<void>
}

function tabOf (target: Pick<ShellWindow, 'tabs'>, tabId: string | undefined): TabState | undefined {
  const { tabs, activeTabId } = target.tabs.getState()
  const id = tabId ?? activeTabId
  return tabs.find((tab) => tab.id === id)
}

export function copyLinkCommand (target: ShellWindow, deps: ShareDeps, tabId?: string): void {
  const address = shareAddressFor(tabOf(target, tabId))
  if (address === undefined) { showToast(target, 'noAddress'); return }
  try {
    deps.writeClipboard(address)
    showToast(target, 'linkCopied')
  } catch (error) {
    console.error('[os] could not copy the link', error)
    showToast(target, 'linkCopyFailed')
  }
}

/** Asks before handing the message to the mail program; the dialog says the person started it, since no page asked. */
export async function emailLinkCommand (target: ShellWindow, deps: ShareDeps, tabId?: string): Promise<void> {
  const tab = tabOf(target, tabId)
  const address = shareAddressFor(tab)
  if (tab === undefined || address === undefined) { showToast(target, 'noAddress'); return }
  const url = mailtoFor(tab.title, address)
  try {
    const origin = originFromUrl(tab.url) ?? address
    if (!await deps.confirm({ window: target, tabId: tab.id }, { scheme: 'mailto', url, origin, initiator: 'person' })) return
    await deps.openExternal(url)
  } catch (error) {
    console.error('[os] could not open the mail program', error)
  }
}
