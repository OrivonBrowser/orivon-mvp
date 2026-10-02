// Print: the operating system's print dialog for the active tab, backgrounds on. A machine with no
// printer goes straight to Save as PDF, as a browser's print preview does, and `print` is never called
// there: the call never comes back and leaves the tab's page unresponsive for good.
import type { WebContentsPrintOptions } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PageToolDeps } from './deps.js'
import { savePdf } from './save-pdf.js'
import type { PdfContents } from './save-pdf.js'
import { showToast } from './toast.js'
import { withTimeout } from './with-timeout.js'

export interface PrintContents extends PdfContents {
  getPrintersAsync: () => Promise<unknown[]>
  print: (options: WebContentsPrintOptions, callback: (success: boolean, failureReason: string) => void) => void
}

const PRINTERS_MS = 5000

export async function printPage (window: ShellWindow, page: { wc: PrintContents, title: string }, deps: PageToolDeps): Promise<void> {
  const { wc } = page
  if (wc.isCrashed()) { showToast(window, 'printFailed'); return }
  let printers: unknown[]
  try {
    printers = await withTimeout(wc.getPrintersAsync(), PRINTERS_MS, 'the printer list')
  } catch (error) {
    console.error('[page-tools] could not list printers', error)
    showToast(window, 'printFailed')
    return
  }
  if (printers.length === 0) { await savePdf(window, page, deps); return }
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
