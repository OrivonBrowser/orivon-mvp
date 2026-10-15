import { failedFiles } from '../../verifier/failed-files-store.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** How many files the page in front asked the verifier for and did not get, for the chip in the address bar that says the page is not whole. */
export const filesFailedStatePart: ShellStatePart = {
  name: 'filesFailed',
  read: ({ window }, tabs) => {
    const wc = tabs.activeTabId === null ? undefined : window.tabs.liveWebContents(tabs.activeTabId)
    return { filesFailed: wc === undefined || wc.isDestroyed() ? 0 : failedFiles.count(wc) }
  },
  watch: (_ctx, push) => failedFiles.onChange(push)
}
