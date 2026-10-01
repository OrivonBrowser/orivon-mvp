// Print: the operating system's print dialog for the active tab, backgrounds on. A machine with no
// printer is refused before `print` is called, because the call never comes back there and leaves
// the tab's page unresponsive for good; the toast offers Save as PDF instead.
import type { WebContentsPrintOptions } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'
import { showToast } from './toast.js'
import { withTimeout } from './with-timeout.js'

export interface PrintContents {
  getPrintersAsync: () => Promise<unknown[]>
  print: (options: WebContentsPrintOptions, callback: (success: boolean, failureReason: string) => void) => void
  isCrashed: () => boolean
}

const PRINTERS_MS = 5000

export async function printPage (window: ShellWindow, wc: PrintContents): Promise<void> {
  if (wc.isCrashed()) { showToast(window, 'printFailed'); return }
  let printers: unknown[]
  try {
    printers = await withTimeout(wc.getPrintersAsync(), PRINTERS_MS, 'the printer list')
  } catch (error) {
    console.error('[page-tools] could not list printers', error)
    showToast(window, 'printFailed')
    return
  }
  if (printers.length === 0) { showToast(window, 'noPrinter'); return }
  try {
    wc.print({ silent: false, printBackground: true }, (success, reason) => {
      // Closing the dialog is a choice, not a failure.
      if (!success && !/cancel/i.test(reason)) showToast(window, 'printFailed')
    })
  } catch (error) {
    console.error('[page-tools] print failed', error)
    showToast(window, 'printFailed')
  }
}
